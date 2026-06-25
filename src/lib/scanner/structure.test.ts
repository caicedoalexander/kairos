import { describe, test, expect } from 'vitest';
import { computeStructure, nearestBelow, nearestAbove } from './structure.ts';
import type { Candle } from './types.ts';

function c(h: number, l: number): Candle {
  return { symbol: 'T', timeframe: '15m', openTime: new Date(0), o: l, h, l, c: l, v: 1 };
}

describe('computeStructure', () => {
  test('detecta un swing high y un swing low aislados', () => {
    // índice 3 es pico (h=20); índice 7 es valle (l=1); lookback 2
    const candles = [c(10, 5), c(11, 6), c(12, 7), c(20, 8), c(12, 7), c(11, 6), c(10, 5), c(9, 1), c(10, 5), c(11, 6), c(12, 7)];
    const { supports, resistances } = computeStructure(candles, 2);
    expect(resistances).toContain(20);
    expect(supports).toContain(1);
  });
});

describe('nearestBelow / nearestAbove', () => {
  test('nearestBelow devuelve el mayor nivel ≤ precio o null', () => {
    expect(nearestBelow(100, [90, 95, 110])).toBe(95);
    expect(nearestBelow(80, [90, 95])).toBeNull();
  });
  test('nearestAbove devuelve el menor nivel ≥ precio o null', () => {
    expect(nearestAbove(100, [90, 110, 120])).toBe(110);
    expect(nearestAbove(130, [90, 110])).toBeNull();
  });
});
