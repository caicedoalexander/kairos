import { describe, test, expect } from 'vitest';
import { simulateFill } from './fill.ts';
import type { SimParams } from './types.ts';

const SP: SimParams = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 };

describe('simulateFill', () => {
  test('buy llena por encima del referencePrice (peor que mid)', () => {
    // slippageBps = 2+5 = 7 → adverse 0.0007 → 100*1.0007 = 100.07
    const f = simulateFill('buy', 1, 100, SP);
    expect(f.fillPrice).toBeCloseTo(100.07, 6);
    expect(f.fillPrice).toBeGreaterThan(100);
  });
  test('sell llena por debajo del referencePrice (peor que mid)', () => {
    const f = simulateFill('sell', 1, 100, SP);
    expect(f.fillPrice).toBeCloseTo(99.93, 6);
    expect(f.fillPrice).toBeLessThan(100);
  });
  test('fee siempre positiva y proporcional', () => {
    // fee = 100.07 * 2 * 0.001 = 0.20014
    const f = simulateFill('buy', 2, 100, SP);
    expect(f.fee).toBeCloseTo(0.20014, 6);
    expect(f.fee).toBeGreaterThan(0);
  });
});
