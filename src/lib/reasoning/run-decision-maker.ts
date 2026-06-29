import type { Signal, Strategy } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { ShadowVerdictRow } from '../../db/repositories/shadow-verdicts.ts';

export interface ShadowEvalArgs {
  symbol: string;
  snapshot: unknown;
  riskParams: Record<string, unknown>;
  timeframes: unknown;
}

export interface DecisionMakerDeps {
  getSignal: (signalId: string) => Promise<Signal | null>;
  getStrategy: (strategyId: string) => Promise<Strategy | null>;
  isAlreadyEvaluated: (signalId: string) => Promise<boolean>;
  evaluate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
  persist: (row: ShadowVerdictRow) => Promise<void>;
  audit: (entry: { eventType: string; actor: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

export type DecisionOutcome =
  | { kind: 'persisted'; verdict: LlmVerdict }
  | { kind: 'not_found' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: string };

// Orquestación determinista del shadow eval: carga la señal/estrategia, llama al LLM (vía deps.evaluate
// con failover), persiste el veredicto. Best-effort acotado: SOLO el fallo del modelo (deps.evaluate)
// se traga y se audita como shadow_failed. Las deps de infraestructura
// (getSignal/isAlreadyEvaluated/getStrategy/persist) propagan a propósito: un error de infra se registra
// como un run de Flue fallido, no como un fallo de modelo.
export async function runDecisionMaker(signalId: string, deps: DecisionMakerDeps): Promise<DecisionOutcome> {
  const signal = await deps.getSignal(signalId);
  if (!signal) return { kind: 'not_found' };
  if (await deps.isAlreadyEvaluated(signalId)) return { kind: 'duplicate' };
  const strategy = await deps.getStrategy(signal.strategyId);
  if (!strategy) return { kind: 'not_found' };

  const args: ShadowEvalArgs = {
    symbol: signal.symbol,
    snapshot: signal.snapshot,
    riskParams: strategy.riskParams,
    timeframes: strategy.triggerConfig.timeframes,
  };

  let evaluated: { verdict: import('./verdict-schema.ts').LlmVerdict; modelUsed: string; tokens: number | null };
  try {
    evaluated = await deps.evaluate(args);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await deps.audit({ eventType: 'shadow_failed', actor: 'decision-maker', payload: { signalId, error } });
    } catch {
      /* best-effort: ni el audit puede tumbar el shadow */
    }
    return { kind: 'failed', error };
  }

  // persist FUERA del try: si la DB falla aquí, propaga (es infra, no fallo de modelo) y el run
  // de Flue queda 'failed' — no se mal-etiqueta como shadow_failed (que es SOLO fallo de modelo).
  await deps.persist({
    signalId, verdict: evaluated.verdict, confianza: evaluated.verdict.confianza,
    razonamiento: evaluated.verdict.razonamiento, modelUsed: evaluated.modelUsed, tokens: evaluated.tokens,
  });
  return { kind: 'persisted', verdict: evaluated.verdict };
}
