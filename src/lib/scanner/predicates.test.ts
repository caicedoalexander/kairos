import { describe, test, expect } from 'vitest';
import { predicates, type PredicateCtx } from './predicates.ts';
import type { Features } from './types.ts';

const base: Features = {
  close: 100, emaStack: 'bullish', macdCross: 'up', adx: 30, rsi: 45, rsiPrev: 38, rsiState: 'neutral',
  stochRsi: 0.5, atrPct: 2, bbPosition: 0.5, aboveVwap: true, obv: 1, mfi: 50,
  nearestSupport: 99.7, nearestResistance: 101, distToSupportPct: 0.3,
};
const ctx: PredicateCtx = { deriv: { fundingZ: 0.5, oiChangePct: 1 } };

describe('predicates', () => {
  test('ema_stack_bullish', () => {
    expect(predicates.ema_stack_bullish(base, {}, ctx)).toBe(true);
    expect(predicates.ema_stack_bullish({ ...base, emaStack: 'mixed' }, {}, ctx)).toBe(false);
  });
  test('rsi_cross_up cruza el nivel de abajo a arriba', () => {
    expect(predicates.rsi_cross_up(base, { level: 40 }, ctx)).toBe(true);   // 38<40, 45>=40
    expect(predicates.rsi_cross_up({ ...base, rsiPrev: 41 }, { level: 40 }, ctx)).toBe(false);
  });
  test('above_vwap / near_support / atr_pct_above', () => {
    expect(predicates.above_vwap(base, {}, ctx)).toBe(true);
    expect(predicates.near_support(base, { max_dist_pct: 0.5 }, ctx)).toBe(true);   // 0.3 ≤ 0.5
    expect(predicates.atr_pct_above(base, { max: 4 }, ctx)).toBe(false);            // 2 > 4 falso
  });
  test('funding_z_extreme lee el contexto de derivados', () => {
    expect(predicates.funding_z_extreme(base, { max_abs: 2.5 }, ctx)).toBe(false);  // |0.5|>2.5 falso
    expect(predicates.funding_z_extreme(base, { max_abs: 2.5 }, { deriv: { fundingZ: 3, oiChangePct: null } })).toBe(true);
  });
  test('feature null → predicado false (no lanza)', () => {
    expect(predicates.near_support({ ...base, distToSupportPct: null }, { max_dist_pct: 0.5 }, ctx)).toBe(false);
  });
});
