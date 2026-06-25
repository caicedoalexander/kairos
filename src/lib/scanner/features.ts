import type { Candle, Features, EmaStack, MacdCross, RsiState } from './types.ts';
import {
  ema, rsiSeries, macdSeries, adxSeries, atrSeries, bollingerSeries, stochRsiSeries,
  vwapSeries, obvSeries, mfiSeries, type MacdPoint,
} from './indicators.ts';
import { computeStructure, nearestBelow, nearestAbove } from './structure.ts';

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;

const last = <T>(arr: T[]): T | null => (arr.length > 0 ? arr[arr.length - 1] : null);
const nth = <T>(arr: T[], fromEnd: number): T | null => arr[arr.length + fromEnd] ?? null;

function emaStackOf(e20: number | null, e50: number | null, e200: number | null): EmaStack | null {
  if (e20 === null || e50 === null || e200 === null) return null;
  if (e20 > e50 && e50 > e200) return 'bullish';
  if (e20 < e50 && e50 < e200) return 'bearish';
  return 'mixed';
}

function macdCrossOf(cur: MacdPoint | null, prev: MacdPoint | null): MacdCross | null {
  if (!cur || !prev || cur.MACD == null || cur.signal == null || prev.MACD == null || prev.signal == null) return null;
  const prevAbove = prev.MACD >= prev.signal;
  const curAbove = cur.MACD >= cur.signal;
  if (!prevAbove && curAbove) return 'up';
  if (prevAbove && !curAbove) return 'down';
  return 'none';
}

function rsiStateOf(rsi: number | null): RsiState | null {
  if (rsi === null) return null;
  if (rsi <= RSI_OVERSOLD) return 'oversold';
  if (rsi >= RSI_OVERBOUGHT) return 'overbought';
  return 'neutral';
}

export function computeFeatures(candles: Candle[]): Features {
  // Guarda temprana: si no hay velas, devuelve features vacíos
  if (candles.length === 0) {
    return {
      close: 0,
      emaStack: null,
      macdCross: null,
      adx: null,
      rsi: null,
      rsiPrev: null,
      rsiState: null,
      stochRsi: null,
      atrPct: null,
      bbPosition: null,
      aboveVwap: null,
      obv: null,
      mfi: null,
      nearestSupport: null,
      nearestResistance: null,
      distToSupportPct: null,
    };
  }

  const close = candles[candles.length - 1].c;
  const values = candles.map((c) => c.c);

  const emaStack = emaStackOf(last(ema(values, 20)), last(ema(values, 50)), last(ema(values, 200)));

  const macd = macdSeries(values);
  const macdCross = macdCrossOf(last(macd), nth(macd, -2));

  const adx = last(adxSeries(candles))?.adx ?? null;

  const rsiArr = rsiSeries(values);
  const rsi = last(rsiArr);
  // Obtiene el RSI anterior (hace dos velas) para detectar cambios de estado
  const rsiPrev = nth(rsiArr, -2);
  const rsiState = rsiStateOf(rsi);

  const stochRsi = last(stochRsiSeries(values))?.stochRSI ?? null;

  const atr = last(atrSeries(candles));
  const atrPct = atr !== null ? (atr / close) * 100 : null;

  const bb = last(bollingerSeries(values));
  // Protege contra denominador cero: si banda superior = inferior (serie plana), bbPosition es null
  const bbDenom = bb ? bb.upper - bb.lower : 0;
  const bbPosition = bb && bbDenom !== 0 ? (close - bb.lower) / bbDenom : null;

  const vwap = last(vwapSeries(candles));
  const aboveVwap = vwap !== null ? close > vwap : null;

  const obv = last(obvSeries(candles));
  const mfi = last(mfiSeries(candles));

  const { supports, resistances } = computeStructure(candles);
  const nearestSupport = nearestBelow(close, supports);
  const nearestResistance = nearestAbove(close, resistances);
  const distToSupportPct = nearestSupport !== null ? ((close - nearestSupport) / close) * 100 : null;

  return {
    close, emaStack, macdCross, adx, rsi, rsiPrev, rsiState, stochRsi,
    atrPct, bbPosition, aboveVwap, obv, mfi, nearestSupport, nearestResistance, distToSupportPct,
  };
}
