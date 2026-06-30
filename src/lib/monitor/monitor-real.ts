import { getProtectedOpenPositions, setPositionProtected, closeOpenPosition, type ReconcilePosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs, type BracketLeg } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { notifyBestEffort } from '../../notify/best-effort.ts';
import { fetchLegState, fetchExitFromTrades, type OrderStateClient } from '../execution/real-order/order-state.ts';
import type { RealClient } from '../execution/execute-order-real.ts';
import type { CancelOcoClient } from '../execution/real-order/cancel-oco.ts';
import type { TradingMode } from '../mode.ts';
import { getStrategy } from '../../db/repositories/strategies.ts';
import { parseTrailingConfig } from './trailing-config.ts';
import { computeTrailingSl, applyTrailingStop } from './trailing.ts';

export interface PriceClient { fetchTicker(symbol: string): Promise<{ last?: number; bid?: number }> }

export interface MonitorRealDeps {
  // RealClient & OrderStateClient & CancelOcoClient & PriceClient: FIX M2 (trailing)
  client: RealClient & OrderStateClient & CancelOcoClient & PriceClient;
  mode: TradingMode;
  notify: (text: string) => Promise<{ messageId: string | null }>;
}

const TERMINAL = new Set(['canceled', 'expired', 'rejected']);
const FILLED = new Set(['closed', 'filled']);

// Monitor de cierres reales (testnet/live): detecta el fill server-side del OCO vía polling REST.
// Best-effort por posición. NO resuelve velas (el OCO es la autoridad).
export async function runMonitorTickReal(asOf: Date, deps: MonitorRealDeps): Promise<{ checked: number; closed: number }> {
  const positions = await getProtectedOpenPositions(deps.mode);
  let checked = 0, closed = 0;
  for (const p of positions) {
    checked++;
    try { if (await checkOne(deps, p, asOf)) closed++; }
    catch (err) {
      try { await appendAuditLog({ eventType: 'monitor_error', actor: 'monitor-real', payload: { positionId: p.id, error: err instanceof Error ? err.message : String(err) } }); }
      catch { /* último recurso */ }
    }
  }
  return { checked, closed };
}

async function checkOne(deps: MonitorRealDeps, p: ReconcilePosition, asOf: Date): Promise<boolean> {
  const legs = (await getBracketLegs(p.decisionId ?? '')).filter((l) => l.exchangeOrderId);
  if (legs.length === 0) { await handoff(p); return false; } // sin legs vivas → al reconciler
  const states = await Promise.all(legs.map(async (l) => ({ leg: l, st: await fetchLegState(deps.client, p.symbol, l.exchangeOrderId as string) })));
  const hit = states.find((s) => s.st.filled > 0 && FILLED.has(s.st.status));
  if (hit) return closeFromLeg(deps, p, hit.leg, asOf);
  if (states.every((s) => TERMINAL.has(s.st.status))) { await handoff(p); return false; } // OCO muerto (gap L1)
  await maybeTrail(deps, p);   // OCO vivo → evaluar trailing (el cierre por fill ya tuvo prioridad arriba)
  return false;
}

// Evalúa y aplica el trailing si la estrategia lo tiene activo y la regla lo indica. Best-effort: un fallo
// lo captura el try/catch de runMonitorTickReal. El precio es FRESCO (fetchTicker, FIX H1).
async function maybeTrail(deps: MonitorRealDeps, p: ReconcilePosition): Promise<void> {
  const strat = await getStrategy(p.strategyId);
  const cfg = parseTrailingConfig(strat?.riskParams ?? {});
  if (!cfg) return;
  const ticker = await deps.client.fetchTicker(p.symbol);
  const price = ticker.last;
  if (typeof price !== 'number' || !(price > 0)) return;
  const newSl = computeTrailingSl({ entry: p.entry, currentSl: p.sl, price, cfg });
  if (newSl === null) return;
  await applyTrailingStop({ client: deps.client, mode: deps.mode, notify: deps.notify }, p, newSl);
}

// FIX H2 (close-first): cierra la posición ANTES de insertar el fill. Si otro tick ya la cerró
// (closeOpenPosition=false), no duplica el fill ni re-cierra legs.
async function closeFromLeg(deps: MonitorRealDeps, p: ReconcilePosition, leg: BracketLeg, asOf: Date): Promise<boolean> {
  const exit = await fetchExitFromTrades(deps.client, p.symbol, leg.exchangeOrderId as string);
  const realized = (exit.exitPrice - p.entry) * p.size - exit.exitFee - p.entryFee;
  const closed = await closeOpenPosition(p.id, realized, asOf);
  if (!closed) return false;
  await insertFill({ orderId: leg.id, price: exit.exitPrice, qty: exit.qty, fee: exit.exitFee });
  if (p.decisionId) await closeBracketLegs(p.decisionId, leg.purpose);
  await appendAuditLog({ eventType: 'position_closed_real', actor: 'monitor-real', payload: { positionId: p.id, hitType: leg.purpose, exitPrice: exit.exitPrice, realized } });
  const icon = leg.purpose === 'tp' ? '🟢' : '🔴';
  await notifyBestEffort(deps.notify, `${icon} ${p.symbol}: salida ${leg.purpose.toUpperCase()} @ ${exit.exitPrice} (pnl ${realized.toFixed(2)})`, 'monitor-real');
  return true;
}

// Handoff M3: OCO muerto/ausente sobre posición protegida → protected=false → reconciler A.2.
async function handoff(p: ReconcilePosition): Promise<void> {
  await setPositionProtected(p.id, false);
  await appendAuditLog({ eventType: 'monitor_oco_dead', actor: 'monitor-real', payload: { positionId: p.id } });
}
