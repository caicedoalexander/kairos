import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { persistDecision } from './decisions.ts';
import { insertSignal } from './signals.ts';
import { claimEntryOrder, insertBracketLeg, setOrderExchangeId } from './orders.ts';

const SYMBOL = 'EXIDBTC/USDT';
const STRATEGY_ID = 'exid-strategy';

beforeAll(async () => {
  await migrate();
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
               VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`]);
});
afterEach(async () => {
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('orders exchange_order_id', () => {
  test('setOrderExchangeId actualiza la entry; insertBracketLeg guarda el exchange id del leg', async () => {
    const signalId = await insertSignal({ strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-11T00:00:00Z'),
      snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } });
    const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
    const claim = await claimEntryOrder({ idempotencyKey: signalId, decisionId: decision.id, size: 1, mode: 'testnet' });
    await setOrderExchangeId(claim!.id, 'EX-ENTRY-1');
    await insertBracketLeg({ idempotencyKey: `${signalId}:sl`, decisionId: decision.id, size: 1, purpose: 'sl', parentId: claim!.id, mode: 'testnet', exchangeOrderId: 'EX-SL-1' });

    const rows = await query<{ purpose: string; exchange_order_id: string }>(
      `SELECT purpose, exchange_order_id FROM kairos.orders WHERE decision_id=$1 ORDER BY purpose`, [decision.id]);
    const entry = rows.find((r) => r.purpose === 'entry');
    const sl = rows.find((r) => r.purpose === 'sl');
    expect(entry?.exchange_order_id).toBe('EX-ENTRY-1');
    expect(sl?.exchange_order_id).toBe('EX-SL-1');
  });
});
