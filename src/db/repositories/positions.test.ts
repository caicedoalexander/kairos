import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { openPosition, closePosition, getExposure, getConsecutiveLosses, getDailyRealizedPnl, getOpenPositions, hasOpenPositionForSetup, closeOpenPosition } from './positions.ts';

const SYMBOL = 'POSBTC/USDT';
const OTHER = 'POSETH/USDT';
const STRATEGY_ID = 'positions-test-strategy';

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO UPDATE SET trigger_config = $3::jsonb`,
    [STRATEGY_ID, `{${SYMBOL},${OTHER}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } })],
  );
});
afterEach(async () => {
  await query('DELETE FROM kairos.positions WHERE symbol IN ($1, $2)', [SYMBOL, OTHER]);
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

  test('hasOpenPositionForSetup distingue setups y modos', async () => {
    await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    expect(await hasOpenPositionForSetup(STRATEGY_ID, SYMBOL, 'sim')).toBe(true);
    expect(await hasOpenPositionForSetup(STRATEGY_ID, OTHER, 'sim')).toBe(false);
    expect(await hasOpenPositionForSetup(STRATEGY_ID, SYMBOL, 'testnet')).toBe(false);
  });

  test('closeOpenPosition cierra solo si está open (idempotente)', async () => {
    const id = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    expect(await closeOpenPosition(id, -7, new Date('2026-03-09T00:00:00Z'))).toBe(true);
    expect(await closeOpenPosition(id, -7, new Date('2026-03-09T00:00:00Z'))).toBe(false); // ya cerrada
    const rows = await query<{ status: string; realized_pnl: string }>('SELECT status, realized_pnl FROM kairos.positions WHERE id = $1', [id]);
    expect(rows[0].status).toBe('closed');
    expect(Number(rows[0].realized_pnl)).toBe(-7);
  });

  test('getOpenPositions trae datos del monitor (entryFee, triggerTimeframe) y aísla por modo', async () => {
    await openPosition({ symbol: SYMBOL, entry: 100, size: 2, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim', entryFee: 0.5 });
    const open = await getOpenPositions('sim');
    const mine = open.find((p) => p.symbol === SYMBOL && p.strategyId === STRATEGY_ID);
    expect(mine).toBeDefined();
    expect(mine!.entryFee).toBe(0.5);
    expect(mine!.triggerTimeframe).toBe('15m');     // de trigger_config de la estrategia
    expect(typeof mine!.entry).toBe('number');
    expect(mine!.openedAt).toBeInstanceOf(Date);
    expect((await getOpenPositions('testnet')).some((p) => p.symbol === SYMBOL)).toBe(false);
  });
});
