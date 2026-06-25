import { describe, test, expect } from 'vitest';
import type { Exchange } from 'ccxt';
import { fetchClosedOHLCV } from './ohlcv.ts';

const TF = '15m';
const TF_MS = 15 * 60_000;

function fakeClient(raw: unknown): Exchange {
  return { fetchOHLCV: async () => raw } as unknown as Exchange;
}

describe('fetchClosedOHLCV', () => {
  test('descarta la vela en formación (la última aún abierta)', async () => {
    const raw = [
      [0, 10, 11, 9, 10, 100],
      [TF_MS, 10, 12, 10, 11, 120],
      [2 * TF_MS, 11, 13, 11, 12, 130], // en formación respecto a `now`
    ];
    const now = 2 * TF_MS + 1;
    const rows = await fetchClosedOHLCV(fakeClient(raw), 'BTC/USDT', TF, 0, 1000, now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      symbol: 'BTC/USDT', timeframe: TF, openTime: new Date(0),
      o: 10, h: 11, l: 9, c: 10, v: 100,
    });
    expect(rows[1].openTime).toEqual(new Date(TF_MS));
  });

  test('mapea o/h/l/c/v correctamente', async () => {
    const raw = [[0, 1, 2, 0.5, 1.5, 999]];
    const rows = await fetchClosedOHLCV(fakeClient(raw), 'ETH/USDT', TF, 0, 1000, TF_MS + 1);
    expect(rows[0]).toMatchObject({ o: 1, h: 2, l: 0.5, c: 1.5, v: 999 });
  });

  test('lanza si la respuesta de ccxt está malformada (contrato roto)', async () => {
    const raw = [[0, 10, 11, 9]]; // tupla demasiado corta
    await expect(
      fetchClosedOHLCV(fakeClient(raw), 'BTC/USDT', TF, 0, 1000, TF_MS + 1),
    ).rejects.toThrow();
  });
});
