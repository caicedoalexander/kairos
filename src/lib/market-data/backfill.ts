import ccxt from 'ccxt';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createPerpPublicClient } from '../ccxt-client.ts';
import {
  SYMBOLS, TIMEFRAMES, BACKFILL_DAYS, FETCH_LIMIT, OI_HISTORY_TIMEFRAME, OI_FETCH_LIMIT, timeframeToMs,
} from './config.ts';
import { fetchClosedOHLCV } from './ohlcv.ts';
import { fetchFundingHistory, fetchOpenInterestHistory } from './derivatives.ts';
import type { OhlcvRow, FundingRow, OpenInterestRow } from './types.ts';

const DAY_MS = 86_400_000;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;

export type Sleep = (ms: number) => Promise<void>;

// Reintenta SOLO errores de red de ccxt (recuperables). Validación/otros fallan fuerte.
export async function withRetry<T>(fn: () => Promise<T>, sleep: Sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ccxt.NetworkError && attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
}

export interface CursorSource<Row> {
  fetchPage: (since: number) => Promise<Row[]>;
  upsert: (rows: Row[]) => Promise<number>;
  cursorOf: (row: Row) => number; // timestamp ms de la fila
  step: number;                   // ms a avanzar tras el último cursor
}

// Bucle de backfill resumible por cursor temporal. Genérico para OHLCV/funding/OI (DRY).
// Asume páginas ASCENDENTES por ts (contrato de Binance en fetchOHLCV/fetchFundingRateHistory/
// fetchOpenInterestHistory): usa la última fila como cursor. `step` = ms a saltar tras el último
// cursor (tfMs para OHLCV; 1 ms para funding/OI, registros discretos).
export async function backfillCursor<Row>(
  src: CursorSource<Row>, startSince: number, now: number, sleep: Sleep,
): Promise<number> {
  let since = startSince;
  let total = 0;
  while (since < now) {
    const rows = await withRetry(() => src.fetchPage(since), sleep);
    if (rows.length === 0) break;
    total += await src.upsert(rows);
    const next = src.cursorOf(rows[rows.length - 1]) + src.step;
    if (next <= since) break; // sin avance → corta para no ciclar
    since = next;
  }
  return total;
}

// startSince: desde el último guardado (+step) o BACKFILL_DAYS atrás en arranque en frío.
export function startFrom(latest: Date | null, step: number, now: number): number {
  return latest ? latest.getTime() + step : now - BACKFILL_DAYS * DAY_MS;
}

// v8 ignore start — orquestación CLI: requiere exchange real + Postgres; se valida con
// `npm run backfill` (ver nota final del plan), no en unit tests.
async function main(): Promise<void> {
  const { upsertCandles, getLatestOpenTime } = await import('../../db/repositories/ohlcv-candles.ts');
  const { upsertFundingRates, getLatestFundingTs } = await import('../../db/repositories/funding-rates.ts');
  const { upsertOpenInterest, getLatestOiTs } = await import('../../db/repositories/open-interest.ts');
  const { pool } = await import('../../db/pool.ts');

  const spot = createPublicClient();
  const perp = createPerpPublicClient();
  const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = Date.now();

  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const tfMs = timeframeToMs(timeframe);
      const latest = await getLatestOpenTime(symbol, timeframe);
      const n = await backfillCursor<OhlcvRow>(
        {
          fetchPage: (since) => fetchClosedOHLCV(spot, symbol, timeframe, since, FETCH_LIMIT, now),
          upsert: upsertCandles,
          cursorOf: (r) => r.openTime.getTime(),
          step: tfMs,
        },
        startFrom(latest, tfMs, now), now, sleep,
      );
      console.error(`OHLCV ${symbol} ${timeframe}: +${n}`);
    }

    const fLatest = await getLatestFundingTs(symbol);
    const f = await backfillCursor<FundingRow>(
      {
        fetchPage: (since) => fetchFundingHistory(perp, symbol, since, FETCH_LIMIT),
        upsert: upsertFundingRates,
        cursorOf: (r) => r.ts.getTime(),
        step: 1,
      },
      startFrom(fLatest, 1, now), now, sleep,
    );
    console.error(`funding ${symbol}: +${f}`);

    const oLatest = await getLatestOiTs(symbol);
    const o = await backfillCursor<OpenInterestRow>(
      {
        fetchPage: (since) => fetchOpenInterestHistory(perp, symbol, OI_HISTORY_TIMEFRAME, since, OI_FETCH_LIMIT),
        upsert: upsertOpenInterest,
        cursorOf: (r) => r.ts.getTime(),
        step: 1,
      },
      startFrom(oLatest, 1, now), now, sleep,
    );
    console.error(`OI ${symbol}: +${o}`);
  }

  await pool.end();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await import('dotenv/config');
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Backfill falló:', error);
      process.exit(1);
    });
}
// v8 ignore stop
