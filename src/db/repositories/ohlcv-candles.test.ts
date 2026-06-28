import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { upsertCandles, getLatestOpenTime, getCandles, getClosedCandlesAfter } from './ohlcv-candles.ts';
import type { OhlcvRow } from '../../lib/market-data/types.ts';

const SYMBOL = 'TEST/USDT';

function candle(iso: string, c: number): OhlcvRow {
  return { symbol: SYMBOL, timeframe: '15m', openTime: new Date(iso), o: c, h: c, l: c, c, v: 1 };
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await query('DELETE FROM kairos.ohlcv_candles WHERE symbol = $1', [SYMBOL]);
});

afterAll(async () => {
  await query('DELETE FROM kairos.ohlcv_candles WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('upsertCandles', () => {
  test('inserta velas nuevas y devuelve el conteo', async () => {
    const inserted = await upsertCandles([
      candle('2026-01-01T00:00:00Z', 100),
      candle('2026-01-01T00:15:00Z', 101),
    ]);
    expect(inserted).toBe(2);
  });

  test('es idempotente: re-insertar el mismo lote inserta 0 (PK)', async () => {
    const batch = [candle('2026-01-01T00:00:00Z', 100)];
    await upsertCandles(batch);
    expect(await upsertCandles(batch)).toBe(0);
  });

  test('lote vacío inserta 0', async () => {
    expect(await upsertCandles([])).toBe(0);
  });

  test('chunking: inserta >500 filas en múltiples chunks y suma el total', async () => {
    const base = Date.parse('2026-02-01T00:00:00Z');
    const rows = Array.from({ length: 501 }, (_, i) =>
      candle(new Date(base + i * 15 * 60_000).toISOString(), 100 + i),
    );
    expect(await upsertCandles(rows)).toBe(501); // 500 + 1 → 2 chunks
    expect(await upsertCandles(rows)).toBe(0);    // idempotente tras chunking
  });
});

describe('getLatestOpenTime', () => {
  test('devuelve null cuando no hay velas', async () => {
    expect(await getLatestOpenTime(SYMBOL, '15m')).toBeNull();
  });

  test('devuelve el open_time máximo', async () => {
    await upsertCandles([candle('2026-01-01T00:00:00Z', 100), candle('2026-01-01T00:15:00Z', 101)]);
    const latest = await getLatestOpenTime(SYMBOL, '15m');
    expect(latest?.toISOString()).toBe('2026-01-01T00:15:00.000Z');
  });
});

describe('getCandles', () => {
  test('devuelve el rango ascendente y excluye fuera de [from,to]', async () => {
    await upsertCandles([
      candle('2026-01-01T00:00:00Z', 100),
      candle('2026-01-01T00:15:00Z', 101),
      candle('2026-01-01T00:30:00Z', 102),
    ]);
    const rows = await getCandles(
      SYMBOL, '15m',
      new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:15:00Z'),
    );
    expect(rows.map((r) => r.c)).toEqual([100, 101]);
    expect(rows[0].openTime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('getClosedCandlesAfter', () => {
  test('devuelve velas en [afterOpenTime+1ms, asOf] en orden ascendente y excluye la de entrada', async () => {
    const sym = 'AFTERBTC/USDT';
    await upsertCandles([
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-03-10T00:00:00Z'), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },  // EXCLUIDA: open_time=00:00 no es > 00:05
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-03-10T00:15:00Z'), o: 2, h: 3, l: 1, c: 2.5, v: 12 },    // incluida
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-03-10T00:30:00Z'), o: 3, h: 4, l: 2, c: 3.5, v: 14 },    // incluida
    ]);
    // afterOpenTime=00:05 (estricto >) excluye 00:00; asOf=00:40 incluye hasta 00:30
    const rows = await getClosedCandlesAfter(
      sym, '15m',
      new Date('2026-03-10T00:05:00Z'),
      new Date('2026-03-10T00:40:00Z'),
    );
    expect(rows.map((r) => r.openTime.toISOString())).toEqual([
      '2026-03-10T00:15:00.000Z',
      '2026-03-10T00:30:00.000Z',
    ]);
    expect(rows.map((r) => r.c)).toEqual([2.5, 3.5]);
    // Sin velas en el rango → array vacío
    expect(await getClosedCandlesAfter(sym, '15m', new Date('2026-03-10T01:00:00Z'), new Date('2026-03-10T02:00:00Z'))).toHaveLength(0);
    await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [sym]);
  });

  test('frontera estricta: vela con open_time == afterOpenTime es EXCLUIDA (> no >=)', async () => {
    // Este test discrimina > de >=: con >= (bug) la vela de 00:15 sería incluida; con > (correcto) no.
    const sym = 'BNDTEST/USDT';
    await upsertCandles([
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-04-01T00:00:00Z'), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-04-01T00:15:00Z'), o: 2, h: 3, l: 1, c: 2.5, v: 12 }, // == afterOpenTime → debe excluirse
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-04-01T00:30:00Z'), o: 3, h: 4, l: 2, c: 3.5, v: 14 },
    ]);
    // afterOpenTime = 00:15 exactamente: la vela con open_time=00:15 está en la frontera.
    // Con > (correcto): open_time=00:15 > 00:15 es FALSE → excluida → resultado [00:30]
    // Con >= (bug):     open_time=00:15 >= 00:15 es TRUE  → incluida → resultado [00:15, 00:30]
    const rows = await getClosedCandlesAfter(
      sym, '15m',
      new Date('2026-04-01T00:15:00Z'),
      new Date('2026-04-01T00:40:00Z'),
    );
    expect(rows.map((r) => r.openTime.toISOString())).toEqual(['2026-04-01T00:30:00.000Z']);
    await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [sym]);
  });
});
