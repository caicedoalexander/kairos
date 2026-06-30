import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/ohlcv-candles.ts', () => ({ getLatestOpenTime: vi.fn(), upsertCandles: vi.fn() }));
vi.mock('./ohlcv.ts', () => ({ fetchClosedOHLCV: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));

import { getLatestOpenTime, upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { fetchClosedOHLCV } from './ohlcv.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { refreshOhlcv } from './refresh.ts';
import { SYMBOLS, TIMEFRAMES } from './config.ts';

function fakeClient() { return { loadMarkets: vi.fn(async () => ({})), fetchOHLCV: vi.fn() }; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLatestOpenTime).mockResolvedValue(new Date('2026-06-29T00:00:00Z'));
  vi.mocked(fetchClosedOHLCV).mockResolvedValue([{ symbol: 'BTC/USDT', timeframe: '15m', openTime: new Date(), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
  vi.mocked(upsertCandles).mockResolvedValue(1);
});

describe('refreshOhlcv', () => {
  it('llama loadMarkets una vez y refresca cada symbol×timeframe', async () => {
    const client = fakeClient();
    const r = await refreshOhlcv({ client });
    expect(client.loadMarkets).toHaveBeenCalledTimes(1);
    expect(fetchClosedOHLCV).toHaveBeenCalledTimes(SYMBOLS.length * TIMEFRAMES.length);
    expect(r.upserted).toBe(SYMBOLS.length * TIMEFRAMES.length);
  });

  it('best-effort: un símbolo que falla audita y el resto continúa', async () => {
    vi.mocked(fetchClosedOHLCV).mockRejectedValueOnce(new Error('rate limit'));
    const r = await refreshOhlcv({ client: fakeClient() });
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ohlcv_refresh_failed' }));
    expect(r.upserted).toBe(SYMBOLS.length * TIMEFRAMES.length - 1); // todos menos el que falló
  });
});
