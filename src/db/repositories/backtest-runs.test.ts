import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertBacktestRun, getBacktestRun } from './backtest-runs.ts';

const STRATEGY_ID = 'bt-runs-test-strategy';
const SYMBOL = 'BTRUNS/USDT';

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 3) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
});
afterAll(async () => {
  await query(`DELETE FROM kairos.backtest_runs WHERE strategy_id = $1`, [STRATEGY_ID]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('backtest-runs repo', () => {
  test('insertBacktestRun persiste y getBacktestRun recupera métricas y trades', async () => {
    const id = await insertBacktestRun({
      strategyId: STRATEGY_ID, strategyVersion: 3, symbol: SYMBOL,
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-02-01T00:00:00Z') },
      mode: 'det',
      simParams: { spread_bps: 4, slippage_bps: 5, fee_bps: 10 },
      metrics: { totalReturnPct: 12.5, trades: 3 },
      trades: [{ realizedPnl: 10, hitType: 'tp' }],
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ulid
    const row = await getBacktestRun(id);
    expect(row).not.toBeNull();
    expect(row!.symbol).toBe(SYMBOL);
    expect(row!.mode).toBe('det');
    expect(row!.metrics.totalReturnPct).toBe(12.5);
    expect(row!.trades).toHaveLength(1);
  });

  test('getBacktestRun devuelve null para id inexistente', async () => {
    expect(await getBacktestRun('00000000000000000000000000')).toBeNull();
  });
});
