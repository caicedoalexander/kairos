import type { Signal, Strategy } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { ShadowVerdictRow } from '../../db/repositories/shadow-verdicts.ts';

export interface ShadowEvalArgs {
  symbol: string;
  snapshot: unknown;
  riskParams: Record<string, unknown>;
  timeframes: unknown;
  technical_read?: TechnicalRead | null;   // lo inyecta la orquestación tras analyze (clave snake → skill)
}

export interface DecisionMakerDeps {
  getSignal: (signalId: string) => Promise<Signal | null>;
  getStrategy: (strategyId: string) => Promise<Strategy | null>;
  isAlreadyEvaluated: (signalId: string) => Promise<boolean>;
  analyze: (args: ShadowEvalArgs) => Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }>;
  evaluate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
  persist: (row: ShadowVerdictRow) => Promise<void>;
  audit: (entry: { eventType: string; actor: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

export type DecisionOutcome =
  | { kind: 'persisted'; verdict: LlmVerdict }
  | { kind: 'not_found' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: string };

// Orquestación determinista del shadow eval. Pasos:
//   1. carga señal/estrategia (infra: propaga si falla);
//   2. analyze (subagente técnico) con DEGRADACIÓN best-effort: fallo → technical_read=null + audit;
//   3. evaluate (decision-protocol) con el read inyectado en args;
//   4. persist read+veredicto. SOLO el fallo de evaluate se traga como shadow_failed (con el read
//      para no perder costo/observabilidad, R3); persist propaga (infra), como en SP7.
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

  // Paso 2: lectura técnica con degradación. El read es enriquecimiento, no dependencia dura.
  let technicalRead: TechnicalRead | null = null;
  let technicalModel: string | null = null;
  let technicalTokens: number | null = null;
  try {
    const a = await deps.analyze(args);
    technicalRead = a.read; technicalModel = a.modelUsed; technicalTokens = a.tokens;
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.name : 'unknown';
    try {
      await deps.audit({ eventType: 'technical_read_failed', actor: 'technical-analyst', payload: { signalId, error, errorType } });
    } catch { /* best-effort: ni el audit puede tumbar el shadow */ }
  }

  // Paso 3: veredicto, con el read inyectado en los args (snake_case → lo lee decision-protocol).
  const evalArgs: ShadowEvalArgs = { ...args, technical_read: technicalRead };
  let evaluated: { verdict: LlmVerdict; modelUsed: string; tokens: number | null };
  try {
    evaluated = await deps.evaluate(evalArgs);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await deps.audit({
        eventType: 'shadow_failed', actor: 'decision-maker',
        payload: { signalId, error, technicalRead, technicalModel, technicalTokens },  // R3
      });
    } catch { /* best-effort */ }
    return { kind: 'failed', error };
  }

  // persist FUERA del try: si la DB falla aquí, propaga (infra, no fallo de modelo) → run Flue 'failed'.
  await deps.persist({
    signalId, verdict: evaluated.verdict, confianza: evaluated.verdict.confianza,
    razonamiento: evaluated.verdict.razonamiento, modelUsed: evaluated.modelUsed, tokens: evaluated.tokens,
    technicalRead, technicalModel, technicalTokens,
  });
  return { kind: 'persisted', verdict: evaluated.verdict };
}
