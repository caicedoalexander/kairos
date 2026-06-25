import { describe, test, expect } from 'vitest';
import { computeFeatures } from './features.ts';
import type { Candle } from './types.ts';

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    symbol: 'T', timeframe: '15m', openTime: new Date(i), o: c, h: c + 0.5, l: c - 0.5, c, v: 100,
  }));
}

describe('computeFeatures', () => {
  test('serie alcista sostenida → emaStack bullish y aboveVwap true', () => {
    const f = computeFeatures(series(Array.from({ length: 250 }, (_, i) => 100 + i)));
    expect(f.emaStack).toBe('bullish');
    expect(f.aboveVwap).toBe(true);
    expect(f.close).toBe(349);
  });

  test('datos insuficientes para EMA200 → emaStack null, sin lanzar', () => {
    const short = series(Array.from({ length: 50 }, (_, i) => 100 + i));
    expect(() => computeFeatures(short)).not.toThrow();
    expect(computeFeatures(short).emaStack).toBeNull();
  });

  test('serie de precio constante → bbPosition null (denominador cero), no NaN/Infinity', () => {
    // 250 velas con cierre constante = banda de Bollinger degenerada (upper === lower)
    const flat = series(Array.from({ length: 250 }, () => 100));
    const f = computeFeatures(flat);
    // bbPosition debe ser null (no NaN, no Infinity)
    expect(f.bbPosition).toBeNull();
    // Validar que si existe, es un número finito
    expect(Number.isFinite(f.bbPosition!) || f.bbPosition === null).toBe(true);
  });

  test('velas vacías → no lanza, devuelve features nulos con close=0', () => {
    expect(() => computeFeatures([])).not.toThrow();
    const f = computeFeatures([]);
    expect(f.close).toBe(0);
    expect(f.emaStack).toBeNull();
    expect(f.bbPosition).toBeNull();
  });
});
