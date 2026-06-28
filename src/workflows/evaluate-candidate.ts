import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { persistDecision } from '../db/repositories/decisions.ts';
import { buildDeterministicVerdict } from '../lib/execution/verdict.ts';
import { checkRiskForDecision, type GatheredState } from '../lib/execution/check-risk.ts';
import { executeOrderSim } from '../lib/execution/execute-order.ts';
import { DEFAULT_SIM_PARAMS } from '../lib/execution/limits.ts';
import { getMode } from '../lib/mode.ts';
import { sendWhatsApp } from '../notify/whatsapp.ts';
import type { ExecutionResult } from '../lib/execution/types.ts';

export type EvaluateOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'executed'; positionId: string | null; status: ExecutionResult['status'] }
  | { kind: 'not_found' };

export interface EvaluateDeps {
  notify: (text: string, to?: string) => Promise<{ messageId: string | null }>;
  riskState?: GatheredState; // solo para tests (igual que checkRiskForDecision.injected)
}

const DEFAULT_DEPS: EvaluateDeps = { notify: sendWhatsApp };

// Orquestador determinista de entrada (sin LLM). Idempotente vía executeOrderSim (idempotency_key=signalId).
export async function evaluateCandidate(signalId: string, deps: Partial<EvaluateDeps> = {}): Promise<EvaluateOutcome> {
  const { notify, riskState } = { ...DEFAULT_DEPS, ...deps };
  const mode = getMode();

  const signal = await getSignalById(signalId);
  if (!signal) return { kind: 'not_found' };
  const strategy = await getStrategy(signal.strategyId);
  if (!strategy) return { kind: 'not_found' };

  const verdict = buildDeterministicVerdict(signal, strategy);
  if (verdict.action === 'skip') {
    return { kind: 'skipped', reason: verdict.reason ?? 'skip' };
  }

  const decision = await persistDecision(signalId, verdict);
  const risk = await checkRiskForDecision({ decision, strategy, symbol: signal.symbol, mode }, riskState);
  if (risk.result !== 'allow' || risk.adjustedSize === null) {
    await notify(`⛔ ${signal.symbol}: rechazado por riesgo — ${risk.reason}`);
    return { kind: 'denied', reason: risk.reason };
  }

  const exec = await executeOrderSim({
    signalId, symbol: signal.symbol, decision, riskResult: risk, strategy,
    referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode,
  });

  if (exec.status === 'filled') {
    // M3: fillPrice/qty son number|null en el tipo; en 'filled' nunca son null (fill dentro de la tx).
    const price = exec.fillPrice ?? 0;
    const qty = exec.qty ?? 0;
    await notify(`✅ ${signal.symbol}: entrada @ ${price} (${qty}) sl=${verdict.sl} tp=${verdict.tp}`);
  } else if (exec.status === 'pending_execution') {
    await notify(`⏳ ${signal.symbol}: ejecución pendiente (no asumida). idem=${exec.idempotencyKey}`);
  }
  return { kind: 'executed', positionId: exec.positionId, status: exec.status };
}
