// src/lib/scanner/config-schema.test.ts
import { describe, test, expect } from 'vitest';
import { parseTriggerConfig } from './config-schema.ts';

const valid = {
  timeframes: { bias: '4h', context: '1h', trigger: '15m' },
  entry: { all: [{ tf: '4h', predicate: 'ema_stack_bullish' }, { tf: '15m', predicate: 'rsi_cross_up', args: { level: 40 } }] },
  skip: { any: [{ predicate: 'funding_z_extreme', args: { max_abs: 2.5 } }] },
};

describe('parseTriggerConfig', () => {
  test('acepta un config válido (árbol anidado)', () => {
    expect(parseTriggerConfig(valid).timeframes.trigger).toBe('15m');
  });
  test('acepta nodos anidados all/any recursivos (v.lazy)', () => {
    const nested = {
      timeframes: { bias: '4h', context: '1h', trigger: '15m' },
      entry: { all: [{ any: [{ predicate: 'ema_stack_bullish' }, { tf: '4h', predicate: 'ema_stack_bearish' }] }] },
    };
    expect(() => parseTriggerConfig(nested)).not.toThrow();
  });
  test('lanza ante predicado desconocido', () => {
    const bad = { ...valid, entry: { all: [{ predicate: 'no_existe' }] } };
    expect(() => parseTriggerConfig(bad)).toThrow();
  });
  test('lanza si faltan timeframes', () => {
    expect(() => parseTriggerConfig({ entry: { all: [] } })).toThrow();
  });
});
