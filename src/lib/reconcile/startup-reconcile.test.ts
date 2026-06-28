import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { persistDecision } from '../../db/repositories/decisions.ts';
import { claimEntryOrder, findStuckEntryOrders, findOrphanedClosedLegs } from '../../db/repositories/orders.ts';
import { executeOrderSim } from '../execution/execute-order.ts';
import { closeOpenPosition } from '../../db/repositories/positions.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { runStartupReconcile } from './startup-reconcile.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { RiskResult } from '../execution/types.ts';

const SYMBOL = 'RECONBTC/USDT';
const STRATEGY_ID = 'recon-test-strategy';
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: {}, version: 1, skillName: null };
const RISK_ALLOW: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 1, notional: 100, limitsSnapshot: {} };

async function seedDecision() {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`, [STRATEGY_ID, `{${SYMBOL}}`]);
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-13T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return { signalId, decision };
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('queries del reconciler', () => {
  test('findStuckEntryOrders detecta una entry pending sin fill', async () => {
    const { decision } = await seedDecision();
    const claimed = await claimEntryOrder({ idempotencyKey: `${decision.id}:stuck`, decisionId: decision.id, size: 1, mode: 'sim' });
    const stuck = await findStuckEntryOrders('sim');
    expect(stuck.some((o) => o.id === claimed!.id)).toBe(true);
  });

  test('findOrphanedClosedLegs detecta legs pending de una posición cerrada', async () => {
    const { signalId, decision } = await seedDecision();
    const exec = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    await closeOpenPosition(exec.positionId!, -1, new Date('2026-03-13T01:00:00Z')); // cierra SIN cerrar legs
    const orphans = await findOrphanedClosedLegs('sim');
    expect(orphans.filter((o) => o.purpose === 'sl' || o.purpose === 'tp').length).toBeGreaterThanOrEqual(2);
  });
});

describe('runStartupReconcile', () => {
  test('audita cada hallazgo y devuelve conteos', async () => {
    const audited: string[] = [];
    const r = await runStartupReconcile({
      findStuckEntries: async () => [{ id: 'o1', idempotency_key: 'k1', purpose: 'entry' }],
      findOrphanedLegs: async () => [{ id: 'o2', idempotency_key: 'k2', purpose: 'sl' }, { id: 'o3', idempotency_key: 'k3', purpose: 'tp' }],
      audit: async (e) => { audited.push(e.eventType); return 'id'; },
    });
    expect(r).toEqual({ stuckEntries: 1, orphanedLegs: 2 });
    expect(audited).toEqual(['reconcile_stuck_order', 'reconcile_orphaned_leg', 'reconcile_orphaned_leg']);
  });

  test('sin hallazgos no audita', async () => {
    let n = 0;
    const r = await runStartupReconcile({ findStuckEntries: async () => [], findOrphanedLegs: async () => [], audit: async () => { n++; return 'id'; } });
    expect(r).toEqual({ stuckEntries: 0, orphanedLegs: 0 });
    expect(n).toBe(0);
  });
});
