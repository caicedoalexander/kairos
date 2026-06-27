import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { loadDataSource, LOOKBACK } from './data-source.ts';
import type { Strategy } from '../scanner/types.ts';
import type { OhlcvRow } from '../market-data/types.ts';

const SYMBOL = 'DSRC/USDT';
const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const STRATEGY: Strategy = {
  id: 'dsrc-strategy', enabled: true, symbols: [SYMBOL],
  triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } },
  riskParams: {}, version: 1, skillName: null,
};

// Genera `n` velas consecutivas de un TF terminando justo antes de `endExclusive`.
function gen(tf: string, startMs: number, n: number): OhlcvRow[] {
  return Array.from({ length: n }, (_, k) => {
    const openTime = new Date(startMs + k * TF_MS[tf]);
    return { symbol: SYMBOL, timeframe: tf, openTime, o: 100, h: 101, l: 99, c: 100, v: 1 };
  });
}

const WINDOW_FROM = new Date('2024-02-01T00:00:00Z');
const WINDOW_TO = new Date('2024-02-02T00:00:00Z');

beforeAll(async () => {
  await migrate();
  // pre-roll generoso (> LOOKBACK) por TF + cobertura de la ventana.
  const preBars = LOOKBACK + 100;
  for (const tf of ['15m', '1h', '4h']) {
    const startMs = WINDOW_FROM.getTime() - preBars * TF_MS[tf];
    const total = preBars + Math.ceil((WINDOW_TO.getTime() - WINDOW_FROM.getTime()) / TF_MS[tf]) + 2;
    await upsertCandles(gen(tf, startMs, total));
  }
});
afterAll(async () => {
  await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [SYMBOL]);
  await pool.end();
});

describe('data-source point-in-time', () => {
  test('triggerCandles solo cubre la ventana [from, to]', async () => {
    const ds = await loadDataSource(STRATEGY, SYMBOL, { from: WINDOW_FROM, to: WINDOW_TO });
    expect(ds.triggerCandles.length).toBeGreaterThan(0);
    for (const c of ds.triggerCandles) {
      expect(c.openTime.getTime()).toBeGreaterThanOrEqual(WINDOW_FROM.getTime());
    }
  });

  test('closedCandlesAt nunca expone una vela con cierre > T (anti look-ahead)', async () => {
    const ds = await loadDataSource(STRATEGY, SYMBOL, { from: WINDOW_FROM, to: WINDOW_TO });
    const i = 10;
    const T = ds.closeTimeAt(i).getTime();
    const byTf = ds.closedCandlesAt(i);
    for (const tf of ['15m', '1h', '4h']) {
      for (const c of byTf[tf]) {
        expect(c.openTime.getTime() + TF_MS[tf]).toBeLessThanOrEqual(T);
      }
      expect(byTf[tf].length).toBeLessThanOrEqual(LOOKBACK); // ventana deslizante
    }
    // la última vela trigger cerrada coincide con la barra i (su cierre == T).
    const trig = byTf['15m'];
    expect(trig[trig.length - 1].openTime.getTime() + TF_MS['15m']).toBe(T);
  });
});
