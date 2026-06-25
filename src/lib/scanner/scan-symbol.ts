// src/lib/scanner/scan-symbol.ts
import type { Strategy, CandlesByTimeframe } from './types.ts';
import { scan } from './scan.ts';
import { computeDerivativesContext } from './derivatives-features.ts';
import { getCandles } from '../../db/repositories/ohlcv-candles.ts';
import { getFundingRange } from '../../db/repositories/funding-rates.ts';
import { getOpenInterestRange } from '../../db/repositories/open-interest.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { timeframeToMs, TIMEFRAMES, type Timeframe } from '../market-data/config.ts';

export const LOOKBACK = 300;           // velas por TF (cubre EMA200 + margen)
const DERIV_LOOKBACK_DAYS = 30;        // ventana para funding_z / oi_change_pct
const DAY_MS = 86_400_000;

// Estrecha un TF de config (string) al union soportado; lanza si es desconocido (evita NaN/Invalid Date).
function asTimeframe(tf: string): Timeframe {
  if ((TIMEFRAMES as readonly string[]).includes(tf)) return tf as Timeframe;
  throw new Error(`timeframe no soportado por el scanner: ${tf}`);
}

// Conveniencia DB-facing: lee velas+derivados de SP1 hasta asOf, llama scan, persiste si dispara.
export async function scanSymbol(strategy: Strategy, symbol: string, asOf: Date): Promise<string | null> {
  const tfs = strategy.triggerConfig.timeframes;
  const candlesByTf: CandlesByTimeframe = {};
  for (const tf of [tfs.bias, tfs.context, tfs.trigger]) {
    const from = new Date(asOf.getTime() - LOOKBACK * timeframeToMs(asTimeframe(tf)));
    candlesByTf[tf] = await getCandles(symbol, tf, from, asOf);
  }

  const derivFrom = new Date(asOf.getTime() - DERIV_LOOKBACK_DAYS * DAY_MS);
  const rates = await getFundingRange(symbol, derivFrom, asOf);
  const ois = await getOpenInterestRange(symbol, derivFrom, asOf);
  const deriv = computeDerivativesContext(rates, ois);

  const signal = scan(strategy, symbol, candlesByTf, deriv, asOf);
  return signal ? insertSignal(signal) : null;
}
