import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query, pool } from '../pool.ts';
import { ulid } from 'ulidx';
import { getOpenPositionBySymbol } from './positions.ts';
import { getLatestClosePrice } from './ohlcv-candles.ts';

const STRAT = 'sp14-reads-strategy';

async function seed(): Promise<void> {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, trigger_config, risk_params)
               VALUES ($1, false, '15m', '{}'::jsonb, '{}'::jsonb)
               ON CONFLICT (id) DO UPDATE SET enabled = false`, [STRAT]);
}

describe('SP14 reads (integración)', () => {
  beforeEach(async () => {
    await seed();
    await query(`DELETE FROM kairos.positions WHERE strategy_id = $1`, [STRAT]);
    await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = 'ZZZ/USDT'`);
  });
  afterAll(async () => {
    await query(`DELETE FROM kairos.positions WHERE strategy_id = $1`, [STRAT]);
    await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = 'ZZZ/USDT'`);
    await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRAT]);
    await pool.end();
  });

  it('getOpenPositionBySymbol devuelve la posición abierta SIN filtros del monitor (sl/tp null OK)', async () => {
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, protected)
                 VALUES ($1, 'ZZZ/USDT', 'long', 100, 0.5, NULL, NULL, 'open', $2, 'testnet', true)`, [ulid(), STRAT]);
    const pos = await getOpenPositionBySymbol('ZZZ/USDT', 'testnet');
    expect(pos?.symbol).toBe('ZZZ/USDT');
    expect(pos?.strategyId).toBe(STRAT);
  });

  it('getOpenPositionBySymbol → null si no hay posición abierta', async () => {
    expect(await getOpenPositionBySymbol('ZZZ/USDT', 'testnet')).toBeNull();
  });

  it('getLatestClosePrice devuelve el close de la vela más reciente', async () => {
    await query(`INSERT INTO kairos.ohlcv_candles (symbol, timeframe, open_time, o, h, l, c, v)
                 VALUES ('ZZZ/USDT','15m', now() - interval '1 hour', 1,1,1, 10, 1),
                        ('ZZZ/USDT','15m', now() - interval '15 minutes', 1,1,1, 20, 1)`);
    expect(await getLatestClosePrice('ZZZ/USDT')).toBe(20);
  });
});
