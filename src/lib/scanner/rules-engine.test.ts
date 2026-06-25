// src/lib/scanner/rules-engine.test.ts
import { describe, test, expect } from 'vitest';
import { evaluateEntry, evaluateSkip } from './rules-engine.ts';
import type { Features, TriggerConfig } from './types.ts';
import type { PredicateCtx } from './predicates.ts';

const bull: Features = {
  close: 100, emaStack: 'bullish', macdCross: 'up', adx: 30, rsi: 45, rsiPrev: 38, rsiState: 'neutral',
  stochRsi: 0.5, atrPct: 2, bbPosition: 0.5, aboveVwap: true, obv: 1, mfi: 50,
  nearestSupport: 99.7, nearestResistance: 101, distToSupportPct: 0.3,
};
const ctx: PredicateCtx = { deriv: { fundingZ: 0.5, oiChangePct: 1 } };
const config: TriggerConfig = {
  timeframes: { bias: '4h', context: '1h', trigger: '15m' },
  entry: { all: [
    { tf: '4h', predicate: 'ema_stack_bullish' },
    { tf: '15m', predicate: 'rsi_cross_up', args: { level: 40 } },
  ] },
  skip: { any: [{ tf: '15m', predicate: 'atr_pct_above', args: { max: 4 } }] },
};
const featuresByTf = { '4h': bull, '1h': bull, '15m': bull };

describe('rules-engine', () => {
  test('entry true cuando todas las hojas se cumplen', () => {
    expect(evaluateEntry(config, featuresByTf, '15m', ctx)).toBe(true);
  });
  test('entry false si una hoja falla', () => {
    expect(evaluateEntry(config, { ...featuresByTf, '4h': { ...bull, emaStack: 'bearish' } }, '15m', ctx)).toBe(false);
  });
  test('skip false con ATR bajo; true cuando el veto aplica', () => {
    expect(evaluateSkip(config, featuresByTf, '15m', ctx)).toBe(false);
    expect(evaluateSkip(config, { ...featuresByTf, '15m': { ...bull, atrPct: 9 } }, '15m', ctx)).toBe(true);
  });
  test('hoja sin tf usa el TF gatillo; features de un TF ausente → false', () => {
    const noTf: TriggerConfig = { ...config, entry: { all: [{ predicate: 'above_vwap' }] }, skip: undefined };
    expect(evaluateEntry(noTf, { '15m': bull }, '15m', ctx)).toBe(true);
    expect(evaluateEntry(noTf, {}, '15m', ctx)).toBe(false);
  });

  test('entry exacto de la estrategia semilla (4 predicados) evalúa true cuando todos se cumplen', () => {
    const seed: TriggerConfig = {
      timeframes: { bias: '4h', context: '1h', trigger: '15m' },
      entry: { all: [
        { tf: '4h', predicate: 'ema_stack_bullish' },
        { tf: '1h', predicate: 'above_vwap' },
        { tf: '15m', predicate: 'rsi_cross_up', args: { level: 40 } },
        { tf: '15m', predicate: 'near_support', args: { max_dist_pct: 0.5 } },
      ] },
    };
    expect(evaluateEntry(seed, featuresByTf, '15m', ctx)).toBe(true);
    const farFromSupport = { ...featuresByTf, '15m': { ...bull, distToSupportPct: 2 } };
    expect(evaluateEntry(seed, farFromSupport, '15m', ctx)).toBe(false);
  });
});
