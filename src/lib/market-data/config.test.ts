import { describe, test, expect } from 'vitest';
import { timeframeToMs, toPerpSymbol } from './config.ts';

describe('timeframeToMs', () => {
  test('mapea 15m a 900000 ms', () => {
    expect(timeframeToMs('15m')).toBe(15 * 60_000);
  });
  test('mapea 1h a 3600000 ms', () => {
    expect(timeframeToMs('1h')).toBe(60 * 60_000);
  });
  test('mapea 4h a 14400000 ms', () => {
    expect(timeframeToMs('4h')).toBe(240 * 60_000);
  });
});

describe('toPerpSymbol', () => {
  test('convierte el símbolo spot al perp USDM (cotizado en USDT)', () => {
    expect(toPerpSymbol('BTC/USDT')).toBe('BTC/USDT:USDT');
  });
});
