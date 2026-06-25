import { describe, test, expect } from 'vitest';
import { computeMtfAlignment, passesMtfGate } from './mtf.ts';
import type { Features, Timeframes, TriggerConfig } from './types.ts';

const tfs: Timeframes = { bias: '4h', context: '1h', trigger: '15m' };
const f = (emaStack: Features['emaStack']): Features => ({
  close: 100, emaStack, macdCross: 'none', adx: null, rsi: null, rsiPrev: null, rsiState: null,
  stochRsi: null, atrPct: null, bbPosition: null, aboveVwap: null, obv: null, mfi: null,
  nearestSupport: null, nearestResistance: null, distToSupportPct: null,
});
const base: TriggerConfig = { timeframes: tfs, entry: { all: [] } };

describe('computeMtfAlignment', () => {
  test('bias bullish + context no bearish → aligned', () => {
    expect(computeMtfAlignment({ '4h': f('bullish'), '1h': f('bullish'), '15m': f('bullish') }, tfs)).toBe('aligned');
  });
  test('bias bearish → counter', () => {
    expect(computeMtfAlignment({ '4h': f('bearish'), '1h': f('bullish'), '15m': f('bullish') }, tfs)).toBe('counter');
  });
  test('bias mixed → mixed', () => {
    expect(computeMtfAlignment({ '4h': f('mixed'), '1h': f('bullish'), '15m': f('bullish') }, tfs)).toBe('mixed');
  });
});

describe('passesMtfGate', () => {
  test('counter no pasa salvo allow_counter', () => {
    expect(passesMtfGate('counter', base)).toBe(false);
    expect(passesMtfGate('counter', { ...base, allow_counter: true })).toBe(true);
  });
  test('aligned y mixed pasan', () => {
    expect(passesMtfGate('aligned', base)).toBe(true);
    expect(passesMtfGate('mixed', base)).toBe(true);
  });
});
