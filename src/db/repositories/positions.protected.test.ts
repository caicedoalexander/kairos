import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { openPosition, setPositionProtected } from './positions.ts';

const SYMBOL = 'PROTBTC/USDT';
const STRATEGY_ID = 'prot-test-strategy';

beforeAll(async () => {
  await migrate();
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
               VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`]);
});
afterEach(async () => { await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]); });
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('positions.protected', () => {
  test('openPosition persiste protected explícito; setPositionProtected lo cambia', async () => {
    const id = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110,
      strategyId: STRATEGY_ID, mode: 'testnet', protected: false });
    const before = await query<{ protected: boolean }>(`SELECT protected FROM kairos.positions WHERE id=$1`, [id]);
    expect(before[0].protected).toBe(false);

    await setPositionProtected(id, true);
    const after = await query<{ protected: boolean }>(`SELECT protected FROM kairos.positions WHERE id=$1`, [id]);
    expect(after[0].protected).toBe(true);
  });
});
