import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { openPosition, closePosition, getExposure, getConsecutiveLosses, getDailyRealizedPnl } from './positions.ts';

const SYMBOL = 'POSBTC/USDT';
const OTHER = 'POSETH/USDT';
const STRATEGY_ID = 'positions-test-strategy';

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL},${OTHER}}`],
  );
});
afterAll(async () => {
  await query('DELETE FROM kairos.positions WHERE symbol IN ($1, $2)', [SYMBOL, OTHER]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('positions', () => {
  test('getExposure suma el notional del símbolo (entry*size) y aísla por símbolo', async () => {
    await openPosition({ symbol: SYMBOL, entry: 100, size: 2, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' }); // 200
    await openPosition({ symbol: SYMBOL, entry: 100, size: 3, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' }); // 300
    await openPosition({ symbol: OTHER, entry: 50, size: 1, sl: 48, tp: 55, strategyId: STRATEGY_ID, mode: 'sim' });    // 50
    const exp = await getExposure('sim', SYMBOL);
    expect(exp.openNotionalSymbol).toBe(500);                  // exacto, aislado por símbolo
    expect(exp.openNotionalTotal).toBeGreaterThanOrEqual(550); // incluye OTHER y posibles de otros archivos
    expect(exp.openPositionsCount).toBeGreaterThanOrEqual(3);
  });

  test('closePosition marca cerrada con realized_pnl; getConsecutiveLosses cuenta la racha por estrategia', async () => {
    const id = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    await closePosition(id, -5, new Date('2026-03-04T00:00:00Z'));
    const id2 = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    await closePosition(id2, -3, new Date('2026-03-04T01:00:00Z'));
    expect(await getConsecutiveLosses('sim', STRATEGY_ID)).toBe(2);
    const closed = await query<{ status: string; realized_pnl: string }>('SELECT status, realized_pnl FROM kairos.positions WHERE id = $1', [id2]);
    expect(closed[0].status).toBe('closed');
    expect(Number(closed[0].realized_pnl)).toBe(-3);
  });

  test('getConsecutiveLosses se rompe en el primer cierre no perdedor', async () => {
    const idWin = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    await closePosition(idWin, 7, new Date('2026-03-04T02:00:00Z')); // cierre ganador más reciente
    expect(await getConsecutiveLosses('sim', STRATEGY_ID)).toBe(0);
  });

  test('getDailyRealizedPnl devuelve un número (Σ cierres del día UTC)', async () => {
    expect(typeof (await getDailyRealizedPnl('sim'))).toBe('number');
  });

  test('openPosition sin entryFee/decisionId usa defaults (0 / null)', async () => {
    const id = await openPosition({ symbol: OTHER, entry: 10, size: 1, sl: 9, tp: 12, strategyId: STRATEGY_ID, mode: 'sim' });
    const rows = await query<{ entry_fee: string; decision_id: string | null }>('SELECT entry_fee, decision_id FROM kairos.positions WHERE id = $1', [id]);
    expect(Number(rows[0].entry_fee)).toBe(0);
    expect(rows[0].decision_id).toBeNull();
  });
});
