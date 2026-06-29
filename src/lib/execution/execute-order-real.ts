// src/lib/execution/execute-order-real.ts
import { claimEntryOrder, getOrderByIdempotencyKey, updateOrderStatus, insertBracketLeg, setOrderExchangeId } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { openPosition, setPositionProtected, closeOpenPosition, hasOpenPositionForSetup } from '../../db/repositories/positions.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { withSetupLock } from './setup-lock.ts';
import { isOpenSetupViolation } from './execute-order.ts';
import { meetsLegMin } from './real-order/precision.ts';
import { DEFAULT_SIM_PARAMS } from './limits.ts';
import type { EntryClient, PlaceEntryArgs, EntryResult } from './real-order/place-entry.ts';
import type { OcoClient, PlaceOcoArgs, OcoResult } from './real-order/place-oco.ts';
import type { EmergencyClient, EmergencyArgs, ExitResult } from './real-order/emergency-close.ts';
import type { Verdict, RiskResult, ExecutionResult } from './types.ts';
import type { TradingMode } from '../mode.ts';

export type RealClient = EntryClient & OcoClient & EmergencyClient;

export interface ExecuteOrderRealParams {
  signalId: string; symbol: string; strategyId: string;
  decision: { id: string; verdict: Verdict };
  riskResult: RiskResult; refPrice: number; mode: TradingMode;
}

export interface RealOrderDeps {
  client: RealClient;
  placeEntry: (client: EntryClient, a: PlaceEntryArgs) => Promise<EntryResult>;
  placeOco: (client: OcoClient, a: PlaceOcoArgs) => Promise<OcoResult>;
  emergencyClose: (client: EmergencyClient, a: EmergencyArgs) => Promise<ExitResult>;
  withLock?: typeof withSetupLock;
  hasOpenForSetup?: typeof hasOpenPositionForSetup;
}

function result(status: ExecutionResult['status'], idem: string, over: Partial<ExecutionResult> = {}): ExecutionResult {
  return { status, idempotencyKey: idem, orderId: over.orderId ?? '', positionId: over.positionId ?? null,
    fillPrice: over.fillPrice ?? null, qty: over.qty ?? null, fee: over.fee ?? null };
}

// Ejecutor real (testnet/live): máquina de estados con compensación. No usa transacción DB (las
// llamadas al exchange están fuera de cualquier tx); la seguridad es OCO residente o cierre de emergencia.
export async function executeOrderReal(p: ExecuteOrderRealParams, deps: RealOrderDeps): Promise<ExecutionResult> {
  const idem = p.signalId;
  const size = p.riskResult.adjustedSize;
  if (p.riskResult.result !== 'allow' || size === null) throw new Error('executeOrderReal requiere riskResult allow con adjustedSize');
  const withLock = deps.withLock ?? withSetupLock;
  const hasOpen = deps.hasOpenForSetup ?? hasOpenPositionForSetup;

  const locked = await withLock(p.strategyId, p.symbol, p.mode, async (): Promise<ExecutionResult> => {
    // Re-check dentro del lock (N5): el pre-check de evaluateCandidate corre fuera del lock.
    if (await hasOpen(p.strategyId, p.symbol, p.mode)) return result('deduped', idem);

    const claim = await claimEntryOrder({ idempotencyKey: idem, decisionId: p.decision.id, size, mode: p.mode });
    if (!claim) {
      const existing = await getOrderByIdempotencyKey(idem);
      return result('duplicate', idem, { orderId: existing?.id ?? '' });
    }

    // Entrada real (puede lanzar = incierta → nunca se asume llenada).
    let entry: EntryResult;
    try { entry = await deps.placeEntry(deps.client, { symbol: p.symbol, size, refPrice: p.refPrice, slippageBps: DEFAULT_SIM_PARAMS.slippage_bps }); }
    catch {
      await updateOrderStatus(claim.id, 'pending_execution');
      await appendAuditLog({ eventType: 'entry_uncertain', actor: 'execute-order-real', payload: { idem } });
      return result('pending_execution', idem, { orderId: claim.id });
    }
    if (entry.belowMin) {
      await updateOrderStatus(claim.id, 'canceled');
      await appendAuditLog({ eventType: 'entry_below_min', actor: 'execute-order-real', payload: { idem } });
      return result('zero_fill', idem, { orderId: claim.id });
    }
    if (entry.filledQty === 0) {
      await updateOrderStatus(claim.id, 'canceled');
      await appendAuditLog({ eventType: 'entry_zero_fill', actor: 'execute-order-real', payload: { idem } });
      return result('zero_fill', idem, { orderId: claim.id });
    }

    // Tengo BTC real. Qty vendible = neta de fee, redondeada a la precisión del exchange.
    const sellableQty = Number(deps.client.amountToPrecision(p.symbol, entry.filledQty - entry.feeBase));
    const market = deps.client.market(p.symbol);
    if (!meetsLegMin(sellableQty, p.refPrice, market.limits.amount.min ?? 0, market.limits.cost.min ?? 0)) {
      await deps.emergencyClose(deps.client, { symbol: p.symbol, qty: sellableQty });
      await updateOrderStatus(claim.id, 'pending_execution');
      await appendAuditLog({ eventType: 'entry_dust_unprotectable', actor: 'execute-order-real', payload: { idem, sellableQty } });
      return result('emergency_closed', idem, { orderId: claim.id });
    }

    await insertFill({ orderId: claim.id, price: entry.avgPrice, qty: entry.filledQty, fee: entry.fee });
    let positionId: string;
    try {
      positionId = await openPosition({ symbol: p.symbol, entry: entry.avgPrice, size: sellableQty, sl: p.decision.verdict.sl,
        tp: p.decision.verdict.tp, strategyId: p.strategyId, mode: p.mode, entryFee: entry.fee, decisionId: p.decision.id, protected: false });
      await updateOrderStatus(claim.id, 'filled');
      await setOrderExchangeId(claim.id, entry.exchangeOrderId);
    } catch (e) {
      if (!isOpenSetupViolation(e)) throw e;
      // Carrera de setup (edge: lock expirado). La compra real YA ocurrió → compensar.
      return await compensateSetupRace(deps, p, claim.id, sellableQty, idem);
    }

    // OCO residente. Fallo → cierre de emergencia (la posición ya existe).
    try {
      const oco = await deps.placeOco(deps.client, { symbol: p.symbol, qty: sellableQty, sl: p.decision.verdict.sl, tp: p.decision.verdict.tp });
      await insertBracketLeg({ idempotencyKey: `${idem}:sl`, decisionId: p.decision.id, size: sellableQty, purpose: 'sl', parentId: claim.id, mode: p.mode, exchangeOrderId: oco.slOrderId });
      await insertBracketLeg({ idempotencyKey: `${idem}:tp`, decisionId: p.decision.id, size: sellableQty, purpose: 'tp', parentId: claim.id, mode: p.mode, exchangeOrderId: oco.tpOrderId });
      await setPositionProtected(positionId, true);
      await appendAuditLog({ eventType: 'order_filled_real', actor: 'execute-order-real', payload: { idem, positionId, orderListId: oco.orderListId } });
      return result('filled', idem, { orderId: claim.id, positionId, fillPrice: entry.avgPrice, qty: sellableQty, fee: entry.fee });
    } catch {
      return await safeEmergency(deps, p, sellableQty, entry.avgPrice, positionId, claim.id, idem);
    }
  });

  // Comprobación estructural: NOT_ACQUIRED tiene { lock: 'not_acquired' }; ExecutionResult tiene { status }.
  // Se usa comparación estructural (no de referencia) para que los mocks de test funcionen correctamente.
  if ((locked as { lock?: string }).lock === 'not_acquired') return result('deduped', idem);
  return locked as ExecutionResult;
}

// Compensación cuando openPosition choca con el índice per-setup (la compra ya pasó, sin fila de posición).
async function compensateSetupRace(deps: RealOrderDeps, p: ExecuteOrderRealParams, orderId: string, qty: number, idem: string): Promise<ExecutionResult> {
  try {
    await deps.emergencyClose(deps.client, { symbol: p.symbol, qty });
    await updateOrderStatus(orderId, 'filled');
    await appendAuditLog({ eventType: 'oco_failed_emergency_closed', actor: 'execute-order-real', payload: { idem, reason: 'setup-race' } });
    return result('emergency_closed', idem, { orderId });
  } catch {
    // Marcador durable QUERYABLE: no hay fila de posición → la entry queda pending_execution.
    await updateOrderStatus(orderId, 'pending_execution');
    await appendAuditLog({ eventType: 'emergency_close_failed', actor: 'execute-order-real', payload: { idem, reason: 'setup-race' } });
    throw new Error(`emergency_close_failed (setup-race) idem=${idem} — posición real sin cerrar`);
  }
}

// Cierre de emergencia tras fallo de OCO (la fila de posición SÍ existe → protected=false es el marcador).
async function safeEmergency(deps: RealOrderDeps, p: ExecuteOrderRealParams, qty: number, avgFillPrice: number, positionId: string, orderId: string, idem: string): Promise<ExecutionResult> {
  try {
    const exit = await deps.emergencyClose(deps.client, { symbol: p.symbol, qty });
    const realized = (exit.exitPrice - avgFillPrice) * qty - exit.exitFee;   // L1: P&L con el fill real, no el planificado
    // M3: el fill de salida se registra contra la entry order (no hay leg en este camino). El reconciler
    //     de SP13 debe tratar 2 fills en una misma entry order como un cierre de emergencia al recalcular P&L.
    await insertFill({ orderId, price: exit.exitPrice, qty, fee: exit.exitFee });
    await closeOpenPosition(positionId, realized, new Date());
    await appendAuditLog({ eventType: 'oco_failed_emergency_closed', actor: 'execute-order-real', payload: { idem, positionId } });
    return result('emergency_closed', idem, { orderId, positionId });
  } catch {
    await appendAuditLog({ eventType: 'emergency_close_failed', actor: 'execute-order-real', payload: { idem, positionId } });
    throw new Error(`emergency_close_failed idem=${idem} positionId=${positionId} — posición real desprotegida (protected=false)`);
  }
}
