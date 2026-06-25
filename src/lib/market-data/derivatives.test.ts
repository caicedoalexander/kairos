import { describe, test, expect } from 'vitest';
import type { Exchange } from 'ccxt';
import { fetchFundingHistory, fetchOpenInterestHistory } from './derivatives.ts';

const fakeFunding = (raw: unknown): Exchange =>
  ({ fetchFundingRateHistory: async () => raw }) as unknown as Exchange;
const fakeOi = (raw: unknown): Exchange =>
  ({ fetchOpenInterestHistory: async () => raw }) as unknown as Exchange;

describe('fetchFundingHistory', () => {
  test('mapea fundingRate/timestamp y conserva el símbolo spot', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', fundingRate: 0.0001, timestamp: 1000, info: {} }];
    const rows = await fetchFundingHistory(fakeFunding(raw), 'BTC/USDT', 0, 1000);
    expect(rows).toEqual([{ symbol: 'BTC/USDT', ts: new Date(1000), rate: 0.0001 }]);
  });

  test('lanza si falta fundingRate (contrato roto)', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', timestamp: 1000, info: {} }];
    await expect(fetchFundingHistory(fakeFunding(raw), 'BTC/USDT', 0)).rejects.toThrow();
  });
});

describe('fetchOpenInterestHistory', () => {
  test('mapea oi y oiValue', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', openInterestAmount: 500, openInterestValue: 1_000_000, timestamp: 2000, info: {} }];
    const rows = await fetchOpenInterestHistory(fakeOi(raw), 'BTC/USDT', '5m', 0, 500);
    expect(rows).toEqual([{ symbol: 'BTC/USDT', ts: new Date(2000), oi: 500, oiValue: 1_000_000 }]);
  });

  test('oiValue es null cuando falta', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', openInterestAmount: 500, timestamp: 2000, info: {} }];
    const rows = await fetchOpenInterestHistory(fakeOi(raw), 'BTC/USDT', '5m', 0);
    expect(rows[0].oiValue).toBeNull();
  });
});
