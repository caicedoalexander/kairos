import type { Signal, Strategy, IndicatorSnapshot } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';
import type { NewsItem } from '../sources/news.ts';
import type { ShadowVerdictRow } from '../../db/repositories/shadow-verdicts.ts';

export interface ShadowEvalArgs {
  symbol: string;
  snapshot: unknown;
  riskParams: Record<string, unknown>;
  timeframes: unknown;
  technical_read?: TechnicalRead | null;
  fundamental_read?: FundamentalRead | null;   // lo inyecta la orquestación tras el paso fundamental
}

type AuditFn = (entry: { eventType: string; actor: string; payload: Record<string, unknown> }) => Promise<unknown>;

export interface DecisionMakerDeps {
  getSignal: (signalId: string) => Promise<Signal | null>;
  getStrategy: (strategyId: string) => Promise<Strategy | null>;
  isAlreadyEvaluated: (signalId: string) => Promise<boolean>;
  analyze: (args: ShadowEvalArgs) => Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }>;
  isMajorCap: (symbol: string) => boolean;
  fetchNews: (symbol: string) => Promise<{ items: NewsItem[]; ok: boolean }>;
  shouldRunFundamental: (news: NewsItem[], snapshot: IndicatorSnapshot) => boolean;
  analyzeFundamental: (args: { symbol: string; news: NewsItem[]; derivatives: unknown }) => Promise<{ read: FundamentalRead; modelUsed: string; tokens: number | null }>;
  evaluate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
  shouldEscalate: (verdict: LlmVerdict, technicalRead: TechnicalRead | null, fundamentalRead: FundamentalRead | null) => boolean;
  escalate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
  persist: (row: ShadowVerdictRow) => Promise<void>;
  audit: AuditFn;
}

export type DecisionOutcome =
  | { kind: 'persisted'; verdict: LlmVerdict }
  | { kind: 'not_found' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: string };

interface FundamentalOutcome {
  read: FundamentalRead | null; model: string | null; tokens: number | null;
  status: string; fetchOk: boolean | null;
}

// Paso fundamental CONDICIONAL y best-effort (SP9). isMajorCap antes del fetch; fetch best-effort
// (fail → audit, sigue); analista solo si el gate pasa; fallo del analista → status='failed' + audit.
async function runFundamentalStep(signalId: string, signal: Signal, deps: DecisionMakerDeps): Promise<FundamentalOutcome> {
  if (!deps.isMajorCap(signal.symbol)) {
    return { read: null, model: null, tokens: null, status: 'skipped_not_major', fetchOk: null };
  }
  let news: NewsItem[] = [];
  let ok = false;
  try {
    const r = await deps.fetchNews(signal.symbol);
    news = r.items; ok = r.ok;
  } catch { ok = false; }   // fetchNews es best-effort por contrato; defensivo
  if (!ok) {
    try {
      await deps.audit({ eventType: 'fundamental_fetch_failed', actor: 'fundamental-source', payload: { signalId, symbol: signal.symbol } });
    } catch { /* best-effort */ }
  }
  if (!deps.shouldRunFundamental(news, signal.snapshot)) {
    return { read: null, model: null, tokens: null, status: ok ? 'skipped_quiet' : 'skipped_fetch_failed', fetchOk: ok };
  }
  try {
    const f = await deps.analyzeFundamental({ symbol: signal.symbol, news, derivatives: signal.snapshot.derivatives });
    return { read: f.read, model: f.modelUsed, tokens: f.tokens, status: 'ran', fetchOk: ok };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.name : 'unknown';
    try {
      await deps.audit({ eventType: 'fundamental_read_failed', actor: 'fundamental-analyst', payload: { signalId, error, errorType } });
    } catch { /* best-effort */ }
    return { read: null, model: null, tokens: null, status: 'failed', fetchOk: ok };
  }
}

// Paso técnico (SP8): lectura técnica con degradación best-effort.
async function runTechnicalStep(signalId: string, args: ShadowEvalArgs, deps: DecisionMakerDeps): Promise<{ read: TechnicalRead | null; model: string | null; tokens: number | null }> {
  try {
    const a = await deps.analyze(args);
    return { read: a.read, model: a.modelUsed, tokens: a.tokens };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.name : 'unknown';
    try {
      await deps.audit({ eventType: 'technical_read_failed', actor: 'technical-analyst', payload: { signalId, error, errorType } });
    } catch { /* best-effort */ }
    return { read: null, model: null, tokens: null };
  }
}

// Orquestación determinista del shadow eval. Pasos: carga (infra propaga) → técnico (degrada) →
// fundamental (condicional, degrada) → evaluate (decision-protocol) con los reads inyectados →
// persist. SOLO el fallo de evaluate → shadow_failed; persist propaga (infra), como SP7/SP8.
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

  const tech = await runTechnicalStep(signalId, args, deps);
  const fund = await runFundamentalStep(signalId, signal, deps);

  const evalArgs: ShadowEvalArgs = { ...args, technical_read: tech.read, fundamental_read: fund.read };
  let first: { verdict: LlmVerdict; modelUsed: string; tokens: number | null };
  try {
    first = await deps.evaluate(evalArgs);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await deps.audit({
        eventType: 'shadow_failed', actor: 'decision-maker',
        payload: { signalId, error, technicalRead: tech.read, technicalModel: tech.model, technicalTokens: tech.tokens,
          fundamentalRead: fund.read, fundamentalModel: fund.model, fundamentalTokens: fund.tokens, fundamentalStatus: fund.status },
      });
    } catch { /* best-effort */ }
    return { kind: 'failed', error };
  }

  // Escalación DELIBERADA (SP10): el código decide, no el modelo. Best-effort: Opus falla → Sonnet + audit.
  let finalVerdict = first.verdict, finalModel = first.modelUsed, finalTokens = first.tokens;
  let escalated = false;
  if (deps.shouldEscalate(first.verdict, tech.read, fund.read)) {
    try {
      const esc = await deps.escalate(evalArgs);
      finalVerdict = esc.verdict; finalModel = esc.modelUsed; finalTokens = esc.tokens; escalated = true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      const errorType = err instanceof Error ? err.name : 'unknown';
      try {
        await deps.audit({ eventType: 'escalation_failed', actor: 'decision-maker', payload: { signalId, error, errorType } });
      } catch { /* best-effort */ }
    }
  }

  await deps.persist({
    signalId, verdict: finalVerdict, confianza: finalVerdict.confianza,
    razonamiento: finalVerdict.razonamiento, modelUsed: finalModel, tokens: finalTokens,
    technicalRead: tech.read, technicalModel: tech.model, technicalTokens: tech.tokens,
    fundamentalRead: fund.read, fundamentalModel: fund.model, fundamentalTokens: fund.tokens,
    fundamentalStatus: fund.status, fundamentalFetchOk: fund.fetchOk,
    escalated,
  });
  return { kind: 'persisted', verdict: finalVerdict };
}
