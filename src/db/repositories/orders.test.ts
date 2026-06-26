import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { claimEntryOrder, getOrderByIdempotencyKey, updateOrderStatus, insertBracketLeg } from './orders.ts';
import { insertFill } from './fills.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'ORDERSBTC/USDT';
const STRATEGY_ID = 'orders-test-strategy';

async function seedDecision(): Promise<string> {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = {
    strategyId: STRATEGY_ID,
    symbol: SYMBOL,
    firedAt: new Date('2026-03-02T00:00:00Z'),
    snapshot: {
      byTimeframe: {},
      mtfAlignment: 'aligned',
      levels: { support: null, resistance: null },
      derivatives: { fundingZ: null, oiChangePct: null },
    },
  };
  const signalId = await insertSignal(signal);
  const { id } = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return id;
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT id FROM kairos.orders WHERE idempotency_key LIKE $1)`, [`${SYMBOL}%`]);
  await query(`DELETE FROM kairos.orders WHERE idempotency_key LIKE $1`, [`${SYMBOL}%`]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('claimEntryOrder (idempotencia)', () => {
  test('un segundo claim con el mismo idempotency_key devuelve null', async () => {
    const decisionId = await seedDecision();
    const key = `${SYMBOL}:e1`;
    const first = await claimEntryOrder({ idempotencyKey: key, decisionId, size: 1, mode: 'sim' });
    expect(first).not.toBeNull();
    expect(await claimEntryOrder({ idempotencyKey: key, decisionId, size: 1, mode: 'sim' })).toBeNull();
    expect((await getOrderByIdempotencyKey(key))?.status).toBe('pending');
  });

  test('updateOrderStatus + insertFill + bracket legs persisten', async () => {
    const decisionId = await seedDecision();
    const key = `${SYMBOL}:e2`;
    const order = await claimEntryOrder({ idempotencyKey: key, decisionId, size: 1, mode: 'sim' });
    await insertFill({ orderId: order!.id, price: 100.07, qty: 1, fee: 0.1 });
    await updateOrderStatus(order!.id, 'filled');
    await insertBracketLeg({ idempotencyKey: `${key}:sl`, decisionId, size: 1, purpose: 'sl', parentId: order!.id, mode: 'sim' });
    await insertBracketLeg({ idempotencyKey: `${key}:tp`, decisionId, size: 1, purpose: 'tp', parentId: order!.id, mode: 'sim' });
    expect((await getOrderByIdempotencyKey(key))?.status).toBe('filled');
  });
});
