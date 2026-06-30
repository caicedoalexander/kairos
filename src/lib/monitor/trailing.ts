import type { TrailingConfig } from './trailing-config.ts';
import { withSetupLock } from '../execution/setup-lock.ts';
import { cancelOco as defaultCancelOco, type CancelOcoClient } from '../execution/real-order/cancel-oco.ts';
import { placeOco as defaultPlaceOco, type OcoResult } from '../execution/real-order/place-oco.ts';
import { getOpenPositionById, setPositionSl, setPositionProtected, type ReconcilePosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, setOrderExchangeId, type BracketLeg } from '../../db/repositories/orders.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import type { RealClient } from '../execution/execute-order-real.ts';
import type { TradingMode } from '../mode.ts';

// Regla pura del trailing. `price` = precio VIVO (fetchTicker, FIX H1). Devuelve el SL nuevo si procede
// subirlo, o null. El SL SOLO sube (ratchet): pasar el último gate con min_step_pct ≥ 0 y currentSl > 0
// implica candidate > currentSl. Línea roja: el SL nunca baja.
export function computeTrailingSl(args: { entry: number; currentSl: number; price: number; cfg: TrailingConfig }): number | null {
  const { entry, currentSl, price, cfg } = args;
  if (price <= entry * (1 + cfg.activation_pct)) return null;       // aún no activa (no en ganancia umbral)
  const candidate = price * (1 - cfg.distance_pct);                 // SL candidato bajo el precio vivo
  if (candidate >= price) return null;                             // sanity (con cfg válido no ocurre)
  if (candidate <= currentSl * (1 + cfg.min_step_pct)) return null; // no supera el SL vigente por min_step → nunca baja + anti-churn
  return candidate;
}

export interface TrailingDeps {
  client: RealClient & CancelOcoClient;
  mode: TradingMode;
  notify: (text: string) => Promise<{ messageId: string | null }>;
  cancelOco?: (client: CancelOcoClient, symbol: string, legs: BracketLeg[]) => Promise<void>;
  placeOco?: (client: RealClient, a: { symbol: string; qty: number; sl: number; tp: number }) => Promise<OcoResult>;
  withLock?: typeof withSetupLock;
}

type PlaceFn = (client: RealClient, a: { symbol: string; qty: number; sl: number; tp: number }) => Promise<OcoResult>;

// Fallback: intenta restaurar el OCO al SL VIEJO. En doble-fallo → baja protected (reconciler A.2).
async function attemptFallback(place: PlaceFn, client: RealClient, pos: ReconcilePosition, legs: BracketLeg[]): Promise<void> {
  try {
    const back = await place(client, { symbol: pos.symbol, qty: pos.size, sl: pos.sl, tp: pos.tp });
    await updateLegsInPlace(legs, back);
    await safeAudit('trailing_restore_oldsl', { positionId: pos.id });
  } catch (err) {
    await setPositionProtected(pos.id, false);                         // doble-fallo → reconciler A.2 al SL viejo
    await safeAudit('trailing_replace_failed', { positionId: pos.id, error: err instanceof Error ? err.message : String(err) });
  }
}

// Mueve el SL recolocando el OCO. Bajo withSetupLock; cancel-first; persiste el SL DESPUÉS del placeOco
// exitoso; fallback al SL viejo si el nuevo falla; protected NO se baja salvo doble-fallo. (FIX H1/H2/H3)
export async function applyTrailingStop(deps: TrailingDeps, position: ReconcilePosition, newSl: number): Promise<void> {
  const lock = deps.withLock ?? withSetupLock;
  const cancel = deps.cancelOco ?? defaultCancelOco;
  const place = deps.placeOco ?? defaultPlaceOco;
  await lock(position.strategyId, position.symbol, deps.mode, async () => {
    const pos = await getOpenPositionById(position.id);                 // FIX M1: re-check por id + protected
    if (!pos || !pos.protected || newSl <= pos.sl) return;             // carrera/cerrada/ya movido → abortar
    if (!pos.decisionId) { await safeAudit('trailing_no_decision_id', { positionId: pos.id }); return; }
    const legs = await getBracketLegs(pos.decisionId);
    try { await cancel(deps.client, pos.symbol, legs); }
    catch (err) { await safeAudit('trailing_cancel_failed', { positionId: pos.id, error: err instanceof Error ? err.message : String(err) }); return; }
    let oco: OcoResult;
    try { oco = await place(deps.client, { symbol: pos.symbol, qty: pos.size, sl: newSl, tp: pos.tp }); }
    catch (err) {
      await safeAudit('trailing_newsl_rejected', { positionId: pos.id, newSl, error: err instanceof Error ? err.message : String(err) });
      // FIX H3: el SL nuevo pudo ser inválido (precio movió) → restaurar el OCO al SL VIEJO (válido)
      await attemptFallback(place, deps.client, pos, legs);
      return;
    }
    await setPositionSl(pos.id, newSl);                                 // FIX H1: persistir DESPUÉS del éxito
    await updateLegsInPlace(legs, oco);
    await safeAudit('trailing_sl_moved', { positionId: pos.id, from: pos.sl, to: newSl });
    try { await deps.notify(`🔧 ${pos.symbol}: SL → ${newSl}`); } catch { /* best-effort */ }
  });
}

async function updateLegsInPlace(legs: BracketLeg[], oco: OcoResult): Promise<void> {
  const sl = legs.find((l) => l.purpose === 'sl');
  const tp = legs.find((l) => l.purpose === 'tp');
  if (sl) await setOrderExchangeId(sl.id, oco.slOrderId);
  if (tp) await setOrderExchangeId(tp.id, oco.tpOrderId);
}

async function safeAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
  try { await appendAuditLog({ eventType, actor: 'trailing', payload }); } catch { /* último recurso */ }
}
