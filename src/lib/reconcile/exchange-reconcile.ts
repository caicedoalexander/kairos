import { findUnresolvedEntries, updateOrderStatus, setOrderExchangeId, insertBracketLeg, type UnresolvedEntry } from '../../db/repositories/orders.ts';
import { openPosition, setPositionProtected } from '../../db/repositories/positions.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getDecisionVerdict } from '../../db/repositories/decisions.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { fetchEntryState, type OrderStateClient } from '../execution/real-order/order-state.ts';
import type { RealClient } from '../execution/execute-order-real.ts';
import type { PlaceOcoArgs, OcoResult } from '../execution/real-order/place-oco.ts';
import type { EmergencyArgs, ExitResult } from '../execution/real-order/emergency-close.ts';
import type { TradingMode } from '../mode.ts';

export interface ReconcileDepsReal {
  client: RealClient & OrderStateClient;
  placeOco: (client: RealClient, a: PlaceOcoArgs) => Promise<OcoResult>;
  emergencyClose: (client: RealClient, a: EmergencyArgs) => Promise<ExitResult>;
  mode: TradingMode;
}

// A.1 — reconcilia entradas inciertas contra el exchange. Best-effort por ítem.
export async function reconcileUnresolvedEntries(deps: ReconcileDepsReal): Promise<{ resolved: number }> {
  const entries = await findUnresolvedEntries(deps.mode);
  let resolved = 0;
  for (const e of entries) {
    try {
      if (await reconcileOneEntry(deps, e)) resolved++;
    } catch (err) {
      await safeAudit('reconcile_entry_error', { orderId: e.id, error: msg(err) });
    }
  }
  return { resolved };
}

async function reconcileOneEntry(deps: ReconcileDepsReal, e: UnresolvedEntry): Promise<boolean> {
  const state = await fetchEntryState(deps.client, e.symbol, e.idempotencyKey);
  if (!state.found || state.filled <= 0) {
    await updateOrderStatus(e.id, 'canceled');
    await appendAuditLog({ eventType: 'reconcile_entry_void', actor: 'reconciler', payload: { orderId: e.id, idem: e.idempotencyKey } });
    return true;
  }
  const verdict = await getDecisionVerdict(e.decisionId);
  if (!verdict) throw new Error(`decisión ${e.decisionId} sin verdict`);
  // Ancla de idempotencia: la fila de posición (índice parcial per-setup). Abre con protected=false.
  const positionId = await openPosition({ symbol: e.symbol, entry: state.average, size: state.filled, sl: verdict.sl,
    tp: verdict.tp, strategyId: e.strategyId, mode: deps.mode, decisionId: e.decisionId, protected: false });
  await insertFill({ orderId: e.id, price: state.average, qty: state.filled, fee: 0 });
  await setOrderExchangeId(e.id, state.exchangeOrderId);   // FIX M-2: id real del exchange, no el clientOrderId
  await updateOrderStatus(e.id, 'filled');
  // Re-protege con OCO residente.
  const oco = await deps.placeOco(deps.client, { symbol: e.symbol, qty: state.filled, sl: verdict.sl, tp: verdict.tp });
  await insertBracketLeg({ idempotencyKey: `${e.idempotencyKey}:sl`, decisionId: e.decisionId, size: state.filled, purpose: 'sl', parentId: e.id, mode: deps.mode, exchangeOrderId: oco.slOrderId });
  await insertBracketLeg({ idempotencyKey: `${e.idempotencyKey}:tp`, decisionId: e.decisionId, size: state.filled, purpose: 'tp', parentId: e.id, mode: deps.mode, exchangeOrderId: oco.tpOrderId });
  await setPositionProtected(positionId, true);
  await appendAuditLog({ eventType: 'reconcile_entry_filled', actor: 'reconciler', payload: { orderId: e.id, positionId, orderListId: oco.orderListId } });
  return true;
}

function msg(err: unknown): string { return err instanceof Error ? err.message : String(err); }
async function safeAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
  try { await appendAuditLog({ eventType, actor: 'reconciler', payload }); } catch { /* último recurso */ }
}
