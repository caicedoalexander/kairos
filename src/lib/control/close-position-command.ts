import { getOpenPositionBySymbol, closeOpenPosition, setPositionProtected, type ReconcilePosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs, type BracketLeg } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getLatestClosePrice } from '../../db/repositories/ohlcv-candles.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { withSetupLock, type NotAcquired } from '../execution/setup-lock.ts';
import { simulateFill } from '../execution/fill.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { type CancelOcoClient } from '../execution/real-order/cancel-oco.ts';
import type { EmergencyClient, EmergencyArgs, ExitResult } from '../execution/real-order/emergency-close.ts';
import type { RealClient } from '../execution/execute-order-real.ts';
import type { OrderStateClient } from '../execution/real-order/order-state.ts';
import type { TradingMode } from '../mode.ts';

export interface ClosePositionDeps {
  mode: TradingMode;
  client?: RealClient & OrderStateClient & CancelOcoClient;   // requerido en testnet|live
  cancelOco: (client: CancelOcoClient, symbol: string, legs: BracketLeg[]) => Promise<void>;
  // FIX M-TYPE-01: el tipo mínimo que el cierre necesita es EmergencyClient (RealClient lo extiende).
  emergencyClose: (client: EmergencyClient, a: EmergencyArgs) => Promise<ExitResult>;
  // Tipo concreto (T=string) en lugar de typeof withSetupLock (genérico): permite passthroughLock en tests.
  withLock?: (strategyId: string, symbol: string, mode: TradingMode, fn: () => Promise<string>) => Promise<string | NotAcquired>;
}

// Cierre de posición por comando (/cierra). Determinista, idempotente, lock-guarded. Despacho por modo.
export async function closePositionCommand(symbol: string, deps: ClosePositionDeps): Promise<string> {
  if (deps.mode === 'sim') return closeSim(symbol);
  return closeReal(symbol, deps);
}

// sim: cierra sintético al último precio almacenado con fill peor que mid (determinista).
async function closeSim(symbol: string): Promise<string> {
  const pos = await getOpenPositionBySymbol(symbol, 'sim');
  if (!pos) return `${symbol}: no hay posición abierta.`;
  const ref = (await getLatestClosePrice(symbol)) ?? pos.entry;
  const fill = simulateFill('sell', pos.size, ref, DEFAULT_SIM_PARAMS);
  const realized = (fill.fillPrice - pos.entry) * pos.size - fill.fee - pos.entryFee;
  await recordClose(pos, fill.fillPrice, fill.fee, realized);
  return `✅ ${symbol} cerrada (sim) @ ${fill.fillPrice.toFixed(2)} (pnl ${realized.toFixed(2)}).`;
}

// testnet|live: cancel-first → market sell → cierra. Bajo withSetupLock (serializa vs ejecutor/otro cierre).
async function closeReal(symbol: string, deps: ClosePositionDeps): Promise<string> {
  const lock: (strategyId: string, symbol: string, mode: TradingMode, fn: () => Promise<string>) => Promise<string | NotAcquired> = deps.withLock ?? withSetupLock;
  const pos0 = await getOpenPositionBySymbol(symbol, deps.mode);
  if (!pos0) return `${symbol}: no hay posición abierta.`;
  const client = deps.client;
  if (!client) throw new Error('closePositionCommand real requiere client');
  const result = await lock(pos0.strategyId, symbol, deps.mode, async () => {
    const pos = await getOpenPositionBySymbol(symbol, deps.mode);    // re-check dentro del lock
    if (!pos) return `${symbol} ya estaba cerrada.`;
    const legs = await getBracketLegs(pos.decisionId ?? '');
    try {
      await deps.cancelOco(client, symbol, legs);                    // cancel-first
    } catch {
      await appendAuditLog({ eventType: 'close_command_failed', actor: 'control', payload: { symbol, stage: 'cancel_oco' } });
      return `No se pudo cancelar el OCO de ${symbol} (red); sigue protegida — reintenta.`;
    }
    let exit: ExitResult;
    try {
      exit = await deps.emergencyClose(client, { symbol, qty: pos.size });
    } catch {
      await setPositionProtected(pos.id, false);                    // FIX H2 → reconciler A.2
      await appendAuditLog({ eventType: 'close_command_failed', actor: 'control', payload: { symbol, stage: 'market_sell' } });
      return `Cierre de ${symbol} falló tras cancelar el OCO; pasará a reconciliación — reintenta.`;
    }
    const realized = (exit.exitPrice - pos.entry) * pos.size - exit.exitFee - pos.entryFee;
    await recordClose(pos, exit.exitPrice, exit.exitFee, realized, legs[0]?.id);
    return `✅ ${symbol} cerrada @ ${exit.exitPrice.toFixed(2)} (pnl ${realized.toFixed(2)}).`;
  });
  // Chequeo ESTRUCTURAL de NOT_ACQUIRED (L-COMPAT-01: consistente con execute-order-real.ts:120; un mock
  // que devuelva {lock:'not_acquired'} distinto a la constante exportada también se detecta).
  if ((result as { lock?: string }).lock === 'not_acquired') return `${symbol}: otro proceso opera este setup — reintenta en unos segundos.`;
  return result as string;
}

// Cierre DB común: fill de salida (best-effort) + closeOpenPosition (ancla idempotente) + legs + audit.
async function recordClose(pos: ReconcilePosition, exitPrice: number, exitFee: number, realized: number, fillOrderId?: string): Promise<void> {
  if (fillOrderId) await insertFill({ orderId: fillOrderId, price: exitPrice, qty: pos.size, fee: exitFee });
  const closed = await closeOpenPosition(pos.id, realized, new Date());
  if (closed && pos.decisionId) await closeBracketLegs(pos.decisionId, 'sl');
  await appendAuditLog({ eventType: 'position_closed_command', actor: 'control', payload: { positionId: pos.id, symbol: pos.symbol, exitPrice, realized } });
}
