import { getCandles } from '../../db/repositories/ohlcv-candles.ts';
import { getFundingRange } from '../../db/repositories/funding-rates.ts';
import { getOpenInterestRange } from '../../db/repositories/open-interest.ts';
import { computeDerivativesContext } from '../scanner/derivatives-features.ts';
import { timeframeToMs, TIMEFRAMES, type Timeframe } from '../market-data/config.ts';
import type { Candle, CandlesByTimeframe, DerivativesContext, Strategy } from '../scanner/types.ts';
import type { Window } from './types.ts';

export const LOOKBACK = 300;          // velas por TF entregadas a scan (paridad con scanSymbol)
const PREROLL_BARS = LOOKBACK + 50;   // historia antes de `from` para satisfacer warmup
const DERIV_LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;

function asTimeframe(tf: string): Timeframe {
  if ((TIMEFRAMES as readonly string[]).includes(tf)) return tf as Timeframe;
  throw new Error(`timeframe no soportado por el backtester: ${tf}`);
}

// Último índice con cierre (openTime + tfMs) <= T. Búsqueda binaria (candles ASC). -1 si ninguno.
function lastClosedIndex(candles: readonly Candle[], T: number, tfMs: number): number {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].openTime.getTime() + tfMs <= T) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

export interface BacktestDataSource {
  triggerCandles: readonly Candle[];
  closeTimeAt(i: number): Date;
  closedCandlesAt(i: number): CandlesByTimeframe;
  derivativesAt(T: Date): DerivativesContext;
}

export async function loadDataSource(strategy: Strategy, symbol: string, window: Window): Promise<BacktestDataSource> {
  const tfs = strategy.triggerConfig.timeframes;
  const tfList = [tfs.bias, tfs.context, tfs.trigger];
  const fullByTf: Record<string, Candle[]> = {};
  for (const tf of tfList) {
    const preroll = PREROLL_BARS * timeframeToMs(asTimeframe(tf));
    fullByTf[tf] = await getCandles(symbol, tf, new Date(window.from.getTime() - preroll), window.to);
  }

  const triggerTfMs = timeframeToMs(asTimeframe(tfs.trigger));
  const triggerCandles = fullByTf[tfs.trigger].filter((c) => c.openTime.getTime() >= window.from.getTime());

  const derivFrom = new Date(window.from.getTime() - DERIV_LOOKBACK_DAYS * DAY_MS);
  const rates = await getFundingRange(symbol, derivFrom, window.to);
  const ois = await getOpenInterestRange(symbol, derivFrom, window.to);

  return {
    triggerCandles,
    closeTimeAt(i: number): Date {
      return new Date(triggerCandles[i].openTime.getTime() + triggerTfMs);
    },
    closedCandlesAt(i: number): CandlesByTimeframe {
      const T = triggerCandles[i].openTime.getTime() + triggerTfMs;
      const out: CandlesByTimeframe = {};
      for (const tf of tfList) {
        const tfMs = timeframeToMs(asTimeframe(tf));
        const idx = lastClosedIndex(fullByTf[tf], T, tfMs);
        out[tf] = idx < 0 ? [] : fullByTf[tf].slice(Math.max(0, idx + 1 - LOOKBACK), idx + 1);
      }
      return out;
    },
    derivativesAt(T: Date): DerivativesContext {
      const tMs = T.getTime();
      return computeDerivativesContext(
        rates.filter((x) => x.ts.getTime() <= tMs),
        ois.filter((x) => x.ts.getTime() <= tMs),
      );
    },
  };
}
