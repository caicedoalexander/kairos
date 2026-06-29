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
// con failover), persiste el veredicto. Best-effort: un fallo del modelo se audita y NUNCA se propaga.
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

  try {
    const { verdict, modelUsed, tokens } = await deps.evaluate(args);
    await deps.persist({
      signalId, verdict, confianza: verdict.confianza, razonamiento: verdict.razonamiento, modelUsed, tokens,
    });
    return { kind: 'persisted', verdict };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try { await deps.audit({ eventType: 'shadow_failed', actor: 'decision-maker', payload: { signalId, error } }); } catch { /* best-effort: ni el audit puede tumbar el shadow */ }
    return { kind: 'failed', error };
  }
}
