import { describe, test, expect, vi } from 'vitest';
import { emergencyClose } from './emergency-close.ts';

describe('emergencyClose', () => {
  test('vende a mercado la qty y normaliza el fill de salida', async () => {
    const c = {
      market: () => ({ base: 'BTC' }),
      createMarketSellOrder: vi.fn(async () => ({ id: 'X9', average: 94.9, fee: { cost: 0.47, currency: 'USDT' } })),
    };
    const r = await emergencyClose(c, { symbol: 'BTC/USDT', qty: 0.01 });
    expect(r).toEqual({ exitPrice: 94.9, exitFee: 0.47, exchangeOrderId: 'X9' });
    expect(c.createMarketSellOrder).toHaveBeenCalledWith('BTC/USDT', 0.01);
  });

  test('fees[] (array) → suma todos los costs (rama reduce)', async () => {
    const c = {
      market: () => ({ base: 'BTC' }),
      createMarketSellOrder: vi.fn(async () => ({
        id: 'X10',
        average: 95.0,
        fees: [{ cost: 0.2, currency: 'USDT' }, { cost: 0.1, currency: 'USDT' }],
      })),
    };
    const r = await emergencyClose(c, { symbol: 'BTC/USDT', qty: 0.01 });
    expect(r.exitFee).toBeCloseTo(0.3);
    expect(r.exitPrice).toBe(95.0);
  });
});
