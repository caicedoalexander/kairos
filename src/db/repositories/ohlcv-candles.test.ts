import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { upsertCandles, getLatestOpenTime, getCandles } from './ohlcv-candles.ts';
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
