import * as v from 'valibot';
import type { Exchange } from 'ccxt';
import { toPerpSymbol } from './config.ts';
import type { FundingRow, OpenInterestRow } from './types.ts';

const FundingSchema = v.object({
  fundingRate: v.number(),
  timestamp: v.number(),
});

const OpenInterestSchema = v.object({
  openInterestAmount: v.number(),
  openInterestValue: v.nullish(v.number()),
  timestamp: v.number(),
});

// Funding histórico del perp USDM. Recibe el símbolo spot; persiste el símbolo spot.
// `client` DEBE ser un cliente perp (ccxt.binanceusdm); un cliente Spot consultaría otro mercado.
export async function fetchFundingHistory(
  client: Exchange, symbol: string, since: number, limit = 1000,
): Promise<FundingRow[]> {
  const raw = await client.fetchFundingRateHistory(toPerpSymbol(symbol), since, limit);
  return raw.map((item) => {
    const parsed = v.parse(FundingSchema, item);
    return { symbol, ts: new Date(parsed.timestamp), rate: parsed.fundingRate };
  });
}

// Open interest histórico del perp USDM. oiValue puede faltar → null.
// `client` DEBE ser un cliente perp (ccxt.binanceusdm), igual que fetchFundingHistory.
export async function fetchOpenInterestHistory(
  client: Exchange, symbol: string, timeframe: string, since: number, limit = 500,
): Promise<OpenInterestRow[]> {
  const raw = await client.fetchOpenInterestHistory(toPerpSymbol(symbol), timeframe, since, limit);
  return raw.map((item) => {
    const parsed = v.parse(OpenInterestSchema, item);
    return {
      symbol, ts: new Date(parsed.timestamp),
      oi: parsed.openInterestAmount, oiValue: parsed.openInterestValue ?? null,
    };
  });
}
