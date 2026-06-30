import { findUnresolvedEntries, updateOrderStatus, setOrderExchangeId, insertBracketLeg, getBracketLegs, closeBracketLegs, type UnresolvedEntry, type BracketLeg } from '../../db/repositories/orders.ts';
import { openPosition, setPositionProtected, findUnprotectedPositions, closeOpenPosition, type ReconcilePosition } from '../../db/repositories/positions.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getDecisionVerdict } from '../../db/repositories/decisions.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { fetchEntryState, fetchLegState, fetchExitFromTrades, type OrderStateClient } from '../execution/real-order/order-state.ts';
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
    await safeAudit('reconcile_entry_void', { orderId: e.id, idem: e.idempotencyKey });
    return true;
  }
  const verdict = await getDecisionVerdict(e.decisionId);
  if (!verdict) throw new Error(`decisión ${e.decisionId} sin verdict`);
  /*
   * RIESGO I-1 (declarado, pendiente de verificación en el smoke owner-gated de SP13):
   * Se usa qty BRUTA del exchange (state.filled) y entry_fee=0, a diferencia del executor real
   * (execute-order-real.ts:78) que usa qty NETA (filledQty - feeBase). En Binance spot, el fee
   * de compra suele cobrarse en el activo base (p.ej. BTC), por lo que el balance real disponible
   * puede ser menor a la qty bruta. Si el fee se paga en base, el placeOco que sigue — y el
   * reprotectOrFlatten de A.2 que usa p.size — podrían fallar por saldo insuficiente, dejando
   * la posición protected=false hasta reconciliación/intervención manual.
   * Antes de habilitar el loop continuo y antes de live, el smoke owner-gated debe verificar la
   * moneda del fee de compra en testnet; si es base, corregir restando feeBase (igual que el
   * executor real) ANTES de activar el loop.
   */
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

// A.2 — reconcilia posiciones abiertas desprotegidas. Best-effort por ítem.
export async function reconcileUnprotectedPositions(deps: ReconcileDepsReal): Promise<{ resolved: number }> {
  const positions = await findUnprotectedPositions(deps.mode);
  let resolved = 0;
  for (const p of positions) {
    try { if (await reconcileOnePosition(deps, p)) resolved++; }
    catch (err) { await safeAudit('reconcile_position_error', { positionId: p.id, error: msg(err) }); }
  }
  return { resolved };
}

async function reconcileOnePosition(deps: ReconcileDepsReal, p: ReconcilePosition): Promise<boolean> {
  const legs = (await getBracketLegs(p.decisionId ?? '')).filter((l) => l.exchangeOrderId);
  const states = await Promise.all(legs.map(async (l) => ({ leg: l, st: await fetchLegState(deps.client, p.symbol, l.exchangeOrderId as string) })));
  const filled = states.find((s) => s.st.filled > 0 && (s.st.status === 'closed' || s.st.status === 'filled'));
  if (filled) return closePositionFromExchange(deps, p, filled.leg);
  const liveLegs = states.some((s) => s.st.status === 'open');
  if (liveLegs) {
    // OCO vivo: el crash fue antes del flip de protected
    await setPositionProtected(p.id, true);
    await appendAuditLog({ eventType: 'reconcile_reprotected_noop', actor: 'reconciler', payload: { positionId: p.id } });
    return true;
  }
  return reprotectOrFlatten(deps, p, legs); // sin OCO vivo → re-protege o aplana
}

async function closePositionFromExchange(deps: ReconcileDepsReal, p: ReconcilePosition, leg: BracketLeg): Promise<boolean> {
  const exit = await fetchExitFromTrades(deps.client, p.symbol, leg.exchangeOrderId as string);
  const realized = (exit.exitPrice - p.entry) * p.size - exit.exitFee - p.entryFee;
  const closed = await closeOpenPosition(p.id, realized, new Date());
  if (closed && p.decisionId) await closeBracketLegs(p.decisionId, leg.purpose);
  if (closed) await appendAuditLog({ eventType: 'reconcile_position_closed', actor: 'reconciler', payload: { positionId: p.id, realized } });
  return closed;
}

async function reprotectOrFlatten(deps: ReconcileDepsReal, p: ReconcilePosition, legs: BracketLeg[]): Promise<boolean> {
  try {
    const oco = await deps.placeOco(deps.client, { symbol: p.symbol, qty: p.size, sl: p.sl, tp: p.tp });
    if (p.decisionId) await persistOcoLegs(p.decisionId, p.id, p.size, deps.mode, legs, oco);
    await setPositionProtected(p.id, true);
    await appendAuditLog({ eventType: 'reconcile_reprotected', actor: 'reconciler', payload: { positionId: p.id, orderListId: oco.orderListId } });
    return true;
  } catch {
    const exit = await deps.emergencyClose(deps.client, { symbol: p.symbol, qty: p.size });
    const realized = (exit.exitPrice - p.entry) * p.size - exit.exitFee - p.entryFee;
    const closed = await closeOpenPosition(p.id, realized, new Date());
    await appendAuditLog({ eventType: 'reconcile_reprotect_emergency', actor: 'reconciler', payload: { positionId: p.id, realized } });
    return closed;
  }
}

// FIX H2: actualiza las legs sl/tp EN SITIO si existen (setOrderExchangeId); inserta solo si faltan.
// Mantiene exactamente 2 filas por decisión (evita las 4 filas divergentes que rompían cancelOco/trailing).
async function persistOcoLegs(decisionId: string, positionId: string, size: number, mode: TradingMode, legs: BracketLeg[], oco: { slOrderId: string; tpOrderId: string }): Promise<void> {
  await upsertLeg(legs, 'sl', oco.slOrderId, decisionId, positionId, size, mode);
  await upsertLeg(legs, 'tp', oco.tpOrderId, decisionId, positionId, size, mode);
}

async function upsertLeg(legs: BracketLeg[], purpose: 'sl' | 'tp', exchangeOrderId: string, decisionId: string, positionId: string, size: number, mode: TradingMode): Promise<void> {
  const existing = legs.find((l) => l.purpose === purpose);
  if (existing) await setOrderExchangeId(existing.id, exchangeOrderId);
  else await insertBracketLeg({ idempotencyKey: `${positionId}:${purpose}`, decisionId, size, purpose, parentId: positionId, mode, exchangeOrderId });
}

// Orquestador: A.1 (entradas) + A.2 (posiciones). Arranque y tick periódico llaman esto.
export async function runExchangeReconcile(deps: ReconcileDepsReal): Promise<{ entries: number; positions: number }> {
  const a1 = await reconcileUnresolvedEntries(deps);
  const a2 = await reconcileUnprotectedPositions(deps);
  return { entries: a1.resolved, positions: a2.resolved };
}
