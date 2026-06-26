import { withTransaction } from '../../db/pool.ts';
import { claimEntryOrder, insertBracketLeg, updateOrderStatus, getOrderByIdempotencyKey } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { openPosition } from '../../db/repositories/positions.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { simulateFill } from './fill.ts';
import type { Verdict, RiskResult, SimParams, ExecutionResult } from './types.ts';
import type { Strategy } from '../scanner/types.ts';
import type { TradingMode } from '../mode.ts';

export interface ExecuteOrderSimParams {
  signalId: string;
  symbol: string;
  decision: { id: string; verdict: Verdict };
  riskResult: RiskResult;
  strategy: Strategy;
  referencePrice: number;
  simParams: SimParams;
  mode: TradingMode;
}

// Orquestador determinista e idempotente del camino del dinero en sim. Una transacción.
export async function executeOrderSim(p: ExecuteOrderSimParams): Promise<ExecutionResult> {
  const idem = p.signalId;                 // §18.3: idempotency_key = signalId
  const size = p.riskResult.adjustedSize;
  if (p.riskResult.result !== 'allow' || size === null) {
    throw new Error('executeOrderSim requiere un riskResult allow con adjustedSize');
  }

  return withTransaction(async (exec) => {
    const claimed = await claimEntryOrder({ idempotencyKey: idem, decisionId: p.decision.id, size, mode: p.mode }, exec);
    if (!claimed) {
      const existing = await getOrderByIdempotencyKey(idem, exec);
      return { status: 'duplicate', idempotencyKey: idem, orderId: existing!.id, positionId: null, fillPrice: null, qty: null, fee: null };
    }

    const fill = simulateFill('buy', size, p.referencePrice, p.simParams);
    await insertFill({ orderId: claimed.id, price: fill.fillPrice, qty: fill.qty, fee: fill.fee }, exec);
    const positionId = await openPosition(
      { symbol: p.symbol, entry: fill.fillPrice, size: fill.qty, sl: p.decision.verdict.sl, tp: p.decision.verdict.tp, strategyId: p.strategy.id, mode: p.mode },
      exec,
    );
    await updateOrderStatus(claimed.id, 'filled', exec);
    await insertBracketLeg({ idempotencyKey: `${idem}:sl`, decisionId: p.decision.id, size: fill.qty, purpose: 'sl', parentId: claimed.id, mode: p.mode }, exec);
    await insertBracketLeg({ idempotencyKey: `${idem}:tp`, decisionId: p.decision.id, size: fill.qty, purpose: 'tp', parentId: claimed.id, mode: p.mode }, exec);
    await appendAuditLog({ eventType: 'order_filled_sim', actor: 'execute_order', payload: { idem, positionId, fillPrice: fill.fillPrice, qty: fill.qty } }, exec);

    return { status: 'filled', idempotencyKey: idem, orderId: claimed.id, positionId, fillPrice: fill.fillPrice, qty: fill.qty, fee: fill.fee };
  });
}
