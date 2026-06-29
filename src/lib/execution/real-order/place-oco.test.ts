// src/lib/execution/real-order/place-oco.test.ts
import { describe, test, expect, vi } from 'vitest';
import ccxt from 'ccxt';
import { placeOco } from './place-oco.ts';

const okRaw = {
  orderListId: 123,
  orderReports: [
    { orderId: 9001, type: 'LIMIT_MAKER' },
    { orderId: 9002, type: 'STOP_LOSS_LIMIT' },
  ],
};
function client(impl: () => Promise<unknown>, capture?: (p: Record<string, string>) => void) {
  return {
    market: () => ({ id: 'BTCUSDT' }),
    amountToPrecision: (_s: string, a: number) => String(a),
    priceToPrecision: (_s: string, p: number) => p.toFixed(2),
    privatePostOrderListOco: vi.fn(async (p: Record<string, string>) => { capture?.(p); return impl(); }),
  };
}

describe('placeOco', () => {
  test('construye SELL OCO (TP LIMIT_MAKER above, SL STOP_LOSS_LIMIT below) y parsea ids', async () => {
    let p: Record<string, string> = {};
    const c = client(async () => okRaw, (x) => { p = x; });
    const r = await placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 });
    expect(r).toEqual({ orderListId: '123', slOrderId: '9002', tpOrderId: '9001' });
    expect(p.symbol).toBe('BTCUSDT'); expect(p.side).toBe('SELL'); expect(p.quantity).toBe('0.01');
    expect(p.aboveType).toBe('LIMIT_MAKER'); expect(p.abovePrice).toBe('110.00');
    expect(p.belowType).toBe('STOP_LOSS_LIMIT'); expect(p.belowStopPrice).toBe('95.00');
    expect(p.belowPrice).toBe('94.81'); // 95·(1−0.002) = 94.81
    expect(p.belowTimeInForce).toBe('GTC');
  });

  test('reintenta ante NetworkError y luego cede al éxito', async () => {
    let n = 0;
    const c = client(async () => { if (n++ < 1) throw new ccxt.NetworkError('blip'); return okRaw; });
    const r = await placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 });
    expect(r.orderListId).toBe('123');
    expect(c.privatePostOrderListOco).toHaveBeenCalledTimes(2);
  });

  test('ExchangeError NO se reintenta (cede ya)', async () => {
    const c = client(async () => { throw new ccxt.ExchangeError('rechazo'); });
    await expect(placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 })).rejects.toThrow('rechazo');
    expect(c.privatePostOrderListOco).toHaveBeenCalledTimes(1);
  });

  test('agotados los retries de NetworkError → lanza', async () => {
    const c = client(async () => { throw new ccxt.NetworkError('down'); });
    await expect(placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 })).rejects.toThrow('down');
  });
});
