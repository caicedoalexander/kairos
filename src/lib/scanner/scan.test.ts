// src/lib/scanner/scan.test.ts
import { describe, test, expect } from 'vitest';
import { scan } from './scan.ts';
import type { Candle, Strategy, CandlesByTimeframe, DerivativesContext } from './types.ts';

const NOW = new Date('2026-03-01T00:00:00Z');
const deriv: DerivativesContext = { fundingZ: 0.5, oiChangePct: 1 };

// Serie alcista de N velas (cierre creciente) → emaStack bullish, aboveVwap true, rsi alto.
function bullish(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i;
    return { symbol: 'BTC/USDT', timeframe: 'x', openTime: new Date(i), o: c, h: c + 0.5, l: c - 0.5, c, v: 100 };
  });
}

const strategy: Strategy = {
  id: 'pullback-alcista', enabled: true, symbols: ['BTC/USDT'], version: 1, riskParams: {},
  triggerConfig: {
    timeframes: { bias: '4h', context: '1h', trigger: '15m' },
    entry: { all: [{ tf: '4h', predicate: 'ema_stack_bullish' }, { tf: '1h', predicate: 'above_vwap' }] },
    skip: { any: [{ predicate: 'funding_z_extreme', args: { max_abs: 2.5 } }] },
  },
};

describe('scan', () => {
  test('datos insuficientes (warmup) → null', () => {
    const candles: CandlesByTimeframe = { '4h': bullish(50), '1h': bullish(50), '15m': bullish(50) };
    expect(scan(strategy, 'BTC/USDT', candles, deriv, NOW)).toBeNull();
  });

  test('setup alcista alineado → dispara signal con snapshot', () => {
    const candles: CandlesByTimeframe = { '4h': bullish(250), '1h': bullish(250), '15m': bullish(250) };
    const sig = scan(strategy, 'BTC/USDT', candles, deriv, NOW);
    expect(sig).not.toBeNull();
    expect(sig?.snapshot.mtfAlignment).toBe('aligned');
    expect(sig?.snapshot.byTimeframe['4h'].emaStack).toBe('bullish');
    expect(sig?.firedAt).toBe(NOW);
  });

  test('skip funding_z_extreme veta aunque entry se cumpla', () => {
    const candles: CandlesByTimeframe = { '4h': bullish(250), '1h': bullish(250), '15m': bullish(250) };
    expect(scan(strategy, 'BTC/USDT', candles, { fundingZ: 3, oiChangePct: null }, NOW)).toBeNull();
  });

  test('sesgo bias bajista → counter → null', () => {
    // 4h bajista (cierres decrecientes), trigger alcista
    const down = Array.from({ length: 250 }, (_, i) => { const c = 350 - i; return { symbol: 'BTC/USDT', timeframe: 'x', openTime: new Date(i), o: c, h: c + 0.5, l: c - 0.5, c, v: 100 }; });
    const candles: CandlesByTimeframe = { '4h': down, '1h': bullish(250), '15m': bullish(250) };
    expect(scan(strategy, 'BTC/USDT', candles, deriv, NOW)).toBeNull();
  });
});
