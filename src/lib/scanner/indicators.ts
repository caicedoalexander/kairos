import {
  EMA, MACD, ADX, RSI, StochasticRSI, ATR, BollingerBands, VWAP, OBV, MFI,
} from 'technicalindicators';
import type { Candle } from './types.ts';

const highs = (c: Candle[]) => c.map((x) => x.h);
const lows = (c: Candle[]) => c.map((x) => x.l);
const closes = (c: Candle[]) => c.map((x) => x.c);
const volumes = (c: Candle[]) => c.map((x) => x.v);

export function ema(values: number[], period: number): number[] {
  return EMA.calculate({ period, values });
}

export function rsiSeries(values: number[], period = 14): number[] {
  return RSI.calculate({ period, values });
}

export interface MacdPoint { MACD?: number; signal?: number; histogram?: number; }
export function macdSeries(values: number[]): MacdPoint[] {
  return MACD.calculate({
    values, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
}

export interface AdxPoint { adx: number; pdi: number; mdi: number; }
export function adxSeries(candles: Candle[], period = 14): AdxPoint[] {
  return ADX.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), period });
}

export function atrSeries(candles: Candle[], period = 14): number[] {
  return ATR.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), period });
}

export interface BollingerPoint { middle: number; upper: number; lower: number; }
export function bollingerSeries(values: number[], period = 20, stdDev = 2): BollingerPoint[] {
  return BollingerBands.calculate({ period, values, stdDev });
}

export interface StochRsiPoint { stochRSI: number; k: number; d: number; }
export function stochRsiSeries(values: number[]): StochRsiPoint[] {
  return StochasticRSI.calculate({ values, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
}

export function vwapSeries(candles: Candle[]): number[] {
  return VWAP.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), volume: volumes(candles) });
}

export function obvSeries(candles: Candle[]): number[] {
  return OBV.calculate({ close: closes(candles), volume: volumes(candles) });
}

export function mfiSeries(candles: Candle[], period = 14): number[] {
  return MFI.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), volume: volumes(candles), period });
}
