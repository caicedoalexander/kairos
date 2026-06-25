import { describe, test, expect } from 'vitest';
import { ema, rsiSeries, atrSeries } from './indicators.ts';
import type { Candle } from './types.ts';

function candle(c: number): Candle {
  return { symbol: 'T', timeframe: '15m', openTime: new Date(0), o: c, h: c + 1, l: c - 1, c, v: 10 };
}

describe('indicators', () => {
  test('ema de serie constante converge a la constante', () => {
    const out = ema(Array(30).fill(100), 10);
    expect(out.length).toBe(30 - 10 + 1);
    expect(out[out.length - 1]).toBeCloseTo(100, 6);
  });

  test('rsiSeries de serie monótona creciente tiende a 100', () => {
    const out = rsiSeries(Array.from({ length: 30 }, (_, i) => i + 1), 14);
    expect(out[out.length - 1]).toBeGreaterThan(95);
  });

  test('atrSeries devuelve una serie no vacía y positiva', () => {
    const candles = Array.from({ length: 20 }, (_, i) => candle(100 + i));
    const out = atrSeries(candles, 14);
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]).toBeGreaterThan(0);
  });
});
