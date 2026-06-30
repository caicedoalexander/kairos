import type { Exchange } from 'ccxt';
import { SYMBOLS, TIMEFRAMES, FETCH_LIMIT, timeframeToMs, type Timeframe } from './config.ts';
import { getLatestOpenTime, upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { fetchClosedOHLCV } from './ohlcv.ts';
import { createPublicClient } from '../ccxt-client.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';

export interface RefreshOhlcvDeps {
  client: Pick<Exchange, 'loadMarkets' | 'fetchOHLCV'>;
  now: () => number;
}

// Frescura OHLCV (SP13, Componente C): mantiene kairos.ohlcv_candles al día para el scanner desatendido.
// Cliente PÚBLICO (sin API key). Best-effort por símbolo. FIX L3: loadMarkets() una vez antes del fetch.
export async function refreshOhlcv(deps: Partial<RefreshOhlcvDeps> = {}): Promise<{ upserted: number }> {
  const client = deps.client ?? createPublicClient();
  const now = deps.now ?? Date.now;
  await client.loadMarkets();
  let upserted = 0;
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      try { upserted += await refreshOne(client as Exchange, symbol, timeframe, now()); }
      catch (err) {
        try { await appendAuditLog({ eventType: 'ohlcv_refresh_failed', actor: 'ohlcv-refresh', payload: { symbol, timeframe, error: err instanceof Error ? err.message : String(err) } }); }
        catch { /* último recurso: fallo de audit no propaga */ }
      }
    }
  }
  return { upserted };
}

async function refreshOne(client: Exchange, symbol: string, timeframe: Timeframe, now: number): Promise<number> {
  const latest = await getLatestOpenTime(symbol, timeframe);
  // since: justo después de la última vela; si no hay historia, las últimas ~2 velas (no backfill completo).
  const since = latest ? latest.getTime() + 1 : now - 2 * timeframeToMs(timeframe);
  const rows = await fetchClosedOHLCV(client, symbol, timeframe, since, FETCH_LIMIT, now);
  return rows.length > 0 ? upsertCandles(rows) : 0;
}
