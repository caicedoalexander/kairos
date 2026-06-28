import { findStuckEntryOrders, findOrphanedClosedLegs, type StuckOrderRow } from '../../db/repositories/orders.ts';
import { appendAuditLog, type AuditLogEntry } from '../../db/repositories/audit-log.ts';
import { getMode } from '../mode.ts';

export interface ReconcileDeps {
  findStuckEntries: () => Promise<StuckOrderRow[]>;
  findOrphanedLegs: () => Promise<StuckOrderRow[]>;
  audit: (entry: AuditLogEntry) => Promise<string>;
}

export interface ReconcileResult { stuckEntries: number; orphanedLegs: number; }

const DEFAULT_DEPS: ReconcileDeps = {
  findStuckEntries: () => findStuckEntryOrders(getMode()),
  findOrphanedLegs: () => findOrphanedClosedLegs(getMode()),
  audit: appendAuditLog,
};

// Reconciler delgado de arranque: solo audita estados inconsistentes de DB (sin ccxt; el diff
// contra exchange es del sprint de testnet). Corre antes de que el scanner dispare.
export async function runStartupReconcile(deps: Partial<ReconcileDeps> = {}): Promise<ReconcileResult> {
  const resolved = { ...DEFAULT_DEPS, ...deps };
  const stuck = await resolved.findStuckEntries();
  for (const o of stuck) {
    await resolved.audit({ eventType: 'reconcile_stuck_order', actor: 'reconciler',
      payload: { orderId: o.id, idempotencyKey: o.idempotency_key, kind: 'stuck_entry' } });
  }
  const legs = await resolved.findOrphanedLegs();
  for (const o of legs) {
    await resolved.audit({ eventType: 'reconcile_orphaned_leg', actor: 'reconciler',
      payload: { orderId: o.id, idempotencyKey: o.idempotency_key, purpose: o.purpose } });
  }
  return { stuckEntries: stuck.length, orphanedLegs: legs.length };
}
