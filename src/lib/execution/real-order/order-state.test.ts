import { describe, it, expect } from 'vitest';
import ccxt from 'ccxt';
import { fetchEntryState, fetchLegState, fetchExitFromTrades, type OrderStateClient } from './order-state.ts';

function client(over: Partial<OrderStateClient>): OrderStateClient {
  return {
    fetchOrder: async () => ({}),
    fetchOrderTrades: async () => [],
    ...over,
  };
}

describe('fetchEntryState', () => {
  it('orden llenada → found con status/filled/average/exchangeOrderId', async () => {
    const c = client({ fetchOrder: async () => ({ id: '12345678', status: 'closed', filled: 0.5, average: 100 }) });
    expect(await fetchEntryState(c, 'BTC/USDT', 'sig-1')).toEqual({ found: true, status: 'closed', filled: 0.5, average: 100, exchangeOrderId: '12345678' });
  });

  it('OrderNotFound → found:false (la entrada nunca llegó al exchange)', async () => {
    const c = client({ fetchOrder: async () => { throw new ccxt.OrderNotFound('no'); } });
    expect(await fetchEntryState(c, 'BTC/USDT', 'sig-1')).toEqual({ found: false });
  });

  it('NetworkError se propaga (no se traga)', async () => {
    const c = client({ fetchOrder: async () => { throw new ccxt.NetworkError('down'); } });
    await expect(fetchEntryState(c, 'BTC/USDT', 'sig-1')).rejects.toThrow(ccxt.NetworkError);
  });
});

describe('fetchLegState', () => {
  it('devuelve status/filled normalizados', async () => {
    const c = client({ fetchOrder: async () => ({ status: 'open', filled: 0 }) });
    expect(await fetchLegState(c, 'BTC/USDT', 'leg-1')).toEqual({ status: 'open', filled: 0 });
  });
});

describe('fetchExitFromTrades', () => {
  it('agrega trades a vwap + suma fees + qty', async () => {
    const c = client({ fetchOrderTrades: async () => [
      { price: 100, amount: 0.4, fee: { cost: 0.04, currency: 'USDT' } },
      { price: 110, amount: 0.6, fee: { cost: 0.066, currency: 'USDT' } },
    ] });
    const r = await fetchExitFromTrades(c, 'BTC/USDT', 'leg-1');
    expect(r.qty).toBeCloseTo(1.0, 8);
    expect(r.exitPrice).toBeCloseTo(106, 8); // (100*0.4 + 110*0.6) / 1.0
    expect(r.exitFee).toBeCloseTo(0.106, 8);
  });

  it('sin trades → exitPrice 0, qty 0 (el caller decide qué hacer)', async () => {
    const c = client({ fetchOrderTrades: async () => [] });
    expect(await fetchExitFromTrades(c, 'BTC/USDT', 'leg-1')).toEqual({ exitPrice: 0, exitFee: 0, qty: 0 });
  });
});
