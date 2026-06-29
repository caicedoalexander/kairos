import { describe, test, expect } from 'vitest';
import { capPrice, stopLimitPrice, feeInBase, meetsLegMin } from './precision.ts';

describe('precision', () => {
  test('capPrice = ref·(1+bps/1e4)', () => {
    expect(capPrice(100, 5)).toBeCloseTo(100.05, 6);
  });
  test('stopLimitPrice = sl·(1−bps/1e4) (límite por debajo del trigger)', () => {
    expect(stopLimitPrice(100, 20)).toBeCloseTo(99.8, 6);
  });
  test('feeInBase suma sólo fees en la moneda base', () => {
    expect(feeInBase([{ cost: 0.001, currency: 'BTC' }, { cost: 0.5, currency: 'USDT' }], undefined, 'BTC')).toBeCloseTo(0.001, 9);
    expect(feeInBase(undefined, { cost: 0.002, currency: 'BTC' }, 'BTC')).toBeCloseTo(0.002, 9);
    expect(feeInBase(undefined, { cost: 0.3, currency: 'BNB' }, 'BTC')).toBe(0); // fee en BNB → 0 en base
  });
  test('meetsLegMin exige qty ≥ minAmount Y notional ≥ minCost', () => {
    expect(meetsLegMin(0.001, 100, 0.0001, 0.1)).toBe(true);   // notional 0.1 >= minCost 0.1
    expect(meetsLegMin(0.00005, 100, 0.0001, 10)).toBe(false); // qty < minAmount
    expect(meetsLegMin(0.05, 100, 0.0001, 0.1)).toBe(true);    // notional 5 >= minCost 0.1
    expect(meetsLegMin(0.05, 1, 0.0001, 10)).toBe(false);      // notional < minCost
  });
});
