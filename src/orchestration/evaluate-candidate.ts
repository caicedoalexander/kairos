import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { persistDecision } from '../db/repositories/decisions.ts';
import { buildDeterministicVerdict } from '../lib/execution/verdict.ts';
import { checkRiskForDecision, type GatheredState } from '../lib/execution/check-risk.ts';
import { executeOrderSim } from '../lib/execution/execute-order.ts';
import { executeOrderReal, type RealClient } from '../lib/execution/execute-order-real.ts';
import { getAuthenticatedClient } from '../lib/ccxt-client.ts';
import { placeEntry } from '../lib/execution/real-order/place-entry.ts';
import { placeOco } from '../lib/execution/real-order/place-oco.ts';
import { emergencyClose } from '../lib/execution/real-order/emergency-close.ts';
import { DEFAULT_SIM_PARAMS } from '../lib/execution/limits.ts';
import { getMode } from '../lib/mode.ts';
import type { TradingMode } from '../lib/mode.ts';
import { sendWhatsApp } from '../notify/whatsapp.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';
import { isSetupOccupied } from '../lib/execution/setup-occupied.ts';
import { notifyBestEffort } from '../notify/best-effort.ts';
import { getPaused } from '../db/repositories/bot-state.ts';
import type { ExecutionResult, Verdict, RiskResult } from '../lib/execution/types.ts';

export type EvaluateOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'executed'; positionId: string | null; status: ExecutionResult['status'] }
  | { kind: 'not_found' };

export interface EvaluateDeps {
  isPaused: () => Promise<boolean>;
  notify: (text: string, to?: string) => Promise<{ messageId: string | null }>;
  riskState?: GatheredState; // solo para tests (igual que checkRiskForDecision.injected)
  executeReal?: (signalId: string, args: { symbol: string; strategyId: string; decision: { id: string; verdict: Verdict }; riskResult: RiskResult; refPrice: number; mode: TradingMode }) => Promise<ExecutionResult>;
}

const defaultExecuteReal: NonNullable<EvaluateDeps['executeReal']> = async (signalId, args) => {
  const client = getAuthenticatedClient();
  await client.loadMarkets();   // H3: idempotente en ccxt; necesario para client.market()/amountToPrecision
  return executeOrderReal({ signalId, ...args }, {
    client: client as unknown as RealClient,   // L2: cast explícito, no `as never`
    placeEntry, placeOco, emergencyClose,
  });
};

const DEFAULT_DEPS: EvaluateDeps = { isPaused: getPaused, notify: sendWhatsApp };

// Orquestador determinista de entrada (sin LLM). Idempotente vía executeOrderSim/executeOrderReal
// (idempotency_key=signalId). En sim: usa executeOrderSim; en testnet/live: usa executeOrderReal.
export async function evaluateCandidate(signalId: string, deps: Partial<EvaluateDeps> = {}): Promise<EvaluateOutcome> {
  const { notify, riskState, isPaused } = { ...DEFAULT_DEPS, ...deps };
  const mode = getMode();

  // H1: kill-switch duro — bloquea la ejecución de jobs ya encolados antes de /pausa (§53).
  if (await isPaused()) {
    try {
      await appendAuditLog({ eventType: 'kill_switch_blocked', actor: 'evaluate-candidate', payload: { signalId, mode } });
    } catch { /* best-effort */ }
    return { kind: 'skipped', reason: 'kill-switch: bot pausado' };
  }

  const signal = await getSignalById(signalId);
  if (!signal) return { kind: 'not_found' };
  const strategy = await getStrategy(signal.strategyId);
  if (!strategy) return { kind: 'not_found' };

  // Dedup per-setup (pre-check barato; el índice parcial es la red ante carreras).
  if (await isSetupOccupied(signal.strategyId, signal.symbol, mode)) {
    try {
      await appendAuditLog({ eventType: 'entry_deduped', actor: 'evaluate-candidate',
        payload: { signalId, strategyId: signal.strategyId, symbol: signal.symbol, mode, via: 'pre-check' } });
    } catch { /* telemetría best-effort: el skip es inocuo aunque falle el audit */ }
    return { kind: 'skipped', reason: 'dedup: posición abierta para el setup' };
  }

  const verdict = buildDeterministicVerdict(signal, strategy);
  if (verdict.action === 'skip') {
    return { kind: 'skipped', reason: verdict.reason ?? 'skip' };
  }

  const decision = await persistDecision(signalId, verdict);
  const risk = await checkRiskForDecision({ decision, strategy, symbol: signal.symbol, mode }, riskState);
  if (risk.result !== 'allow' || risk.adjustedSize === null) {
    await notifyBestEffort(notify, `⛔ ${signal.symbol}: rechazado por riesgo — ${risk.reason}`, 'evaluate-candidate');
    return { kind: 'denied', reason: risk.reason };
  }

  const executeReal = deps.executeReal ?? defaultExecuteReal;
  const exec = mode === 'sim'
    ? await executeOrderSim({ signalId, symbol: signal.symbol, decision, riskResult: risk, strategy,
        referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode })
    : await executeReal(signalId, { symbol: signal.symbol, strategyId: signal.strategyId,
        decision, riskResult: risk, refPrice: verdict.entry, mode });

  if (exec.status === 'deduped') {
    try {
      await appendAuditLog({ eventType: 'entry_deduped', actor: 'evaluate-candidate',
        payload: { signalId, strategyId: signal.strategyId, symbol: signal.symbol, mode, via: 'index-race' } });
    } catch { /* telemetría best-effort: el skip es inocuo aunque falle el audit */ }
    return { kind: 'skipped', reason: 'dedup: carrera con otra señal del mismo setup' };
  }

  if (exec.status === 'filled') {
    // M3: fillPrice/qty son number|null en el tipo; en 'filled' nunca son null (fill dentro de la tx).
    const price = exec.fillPrice ?? 0;
    const qty = exec.qty ?? 0;
    await notifyBestEffort(notify, `✅ ${signal.symbol}: entrada @ ${price} (${qty}) sl=${verdict.sl} tp=${verdict.tp}`, 'evaluate-candidate');
  } else if (exec.status === 'pending_execution') {
    await notifyBestEffort(notify, `⏳ ${signal.symbol}: ejecución pendiente (no asumida). idem=${exec.idempotencyKey}`, 'evaluate-candidate');
  } else if (exec.status === 'zero_fill') {
    await notifyBestEffort(notify, `➖ ${signal.symbol}: sin posición (IOC no cruzó / size < mínimo)`, 'evaluate-candidate');
  } else if (exec.status === 'emergency_closed') {
    await notifyBestEffort(notify, `🚨 ${signal.symbol}: OCO no colocado — posición aplanada por emergencia`, 'evaluate-candidate');
  }
  return { kind: 'executed', positionId: exec.positionId, status: exec.status };
}
