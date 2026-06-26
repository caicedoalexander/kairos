import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision, getDecision } from './decisions.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'DECISIONBTC/USDT';
const STRATEGY_ID = 'decision-test-strategy';

async function seedSignal(): Promise<string> {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = {
    strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-01T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } },
  };
  return insertSignal(signal);
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('persistDecision', () => {
  test('inserta una decision determinista y la lee de vuelta', async () => {
    const signalId = await seedSignal();
    const { id } = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
    const got = await getDecision(id);
    expect(got?.verdict.tp).toBe(110);
  });
});
