import { describe, test, expect } from 'vitest';
import { computeFundingZ, computeOiChangePct } from './derivatives-features.ts';
import type { FundingRow, OpenInterestRow } from '../market-data/types.ts';

const fr = (rate: number): FundingRow => ({ symbol: 'T', ts: new Date(0), rate });
const oi = (v: number): OpenInterestRow => ({ symbol: 'T', ts: new Date(0), oi: v, oiValue: null });

describe('computeFundingZ', () => {
  test('z-score del último valor vs su historia', () => {
    // serie [0,0,0,0,10]: mean=2, sd=4, z=(10-2)/4=2
    expect(computeFundingZ([fr(0), fr(0), fr(0), fr(0), fr(10)])).toBeCloseTo(2, 6);
  });
  test('serie sin varianza → 0; serie corta → null', () => {
    expect(computeFundingZ([fr(5), fr(5)])).toBe(0);
    expect(computeFundingZ([fr(5)])).toBeNull();
  });
});

describe('computeOiChangePct', () => {
  test('cambio porcentual del primero al último', () => {
    expect(computeOiChangePct([oi(100), oi(150)])).toBeCloseTo(50, 6);
  });
  test('serie corta o primer valor 0 → null', () => {
    expect(computeOiChangePct([oi(100)])).toBeNull();
    expect(computeOiChangePct([oi(0), oi(50)])).toBeNull();
  });
});
