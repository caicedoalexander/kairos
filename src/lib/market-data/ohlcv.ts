import * as v from 'valibot';
import type { Exchange } from 'ccxt';
import { timeframeToMs, type Timeframe } from './config.ts';
import type { OhlcvRow } from './types.ts';

// ccxt OHLCV: [timestamp, open, high, low, close, volume]; cada campo Num = number | undefined.
// Exigimos ≥6 numbers reales: un campo undefined o no-numérico = contrato ccxt roto → v.parse lanza.
const OhlcvArraySchema = v.pipe(v.array(v.number()), v.minLength(6));

// Una vela está cerrada si su cierre (open + duración del TF) ya pasó respecto a `now` (§15.3).
function isClosed(openTimeMs: number, timeframe: Timeframe, now: number): boolean {
  return openTimeMs + timeframeToMs(timeframe) <= now;
}

// Trae velas y devuelve SOLO las cerradas, ascendentes. Valida la forma cruda de ccxt:
// una forma rota = contrato ccxt desalineado → lanza (no se descarta en silencio).
export async function fetchClosedOHLCV(
  client: Exchange,
  symbol: string,
  timeframe: Timeframe,
  since: number,
  limit = 1000,
  now: number = Date.now(),
): Promise<OhlcvRow[]> {
  const raw = await client.fetchOHLCV(symbol, timeframe, since, limit);
  return raw
    .map((candle) => v.parse(OhlcvArraySchema, candle))
    .filter((c) => isClosed(c[0], timeframe, now))
    .map((c) => ({
      symbol, timeframe, openTime: new Date(c[0]),
      o: c[1], h: c[2], l: c[3], c: c[4], v: c[5],
    }));
}
