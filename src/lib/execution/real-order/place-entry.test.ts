// src/lib/execution/real-order/place-entry.test.ts
import { describe, test, expect, vi } from 'vitest';
import { placeEntry, type EntryClient } from './place-entry.ts';

// cost.min=1: tests 1&3 tienen notional 0.01*100=1 ≥ 1 (pasan); test 2 tiene notional 0.001 < 1 (belowMin).
const market = { id: 'BTCUSDT', base: 'BTC', limits: { amount: { min: 0.0001 }, cost: { min: 1 } } };
function client(order: unknown, capture?: (args: unknown[]) => void) {
  return {
    market: () => market,
    amountToPrecision: (_s: string, a: number) => String(a),
    priceToPrecision: (_s: string, p: number) => p.toFixed(2),
    createOrder: vi.fn(async (...args: unknown[]) => { capture?.(args); return order; }),
  } as unknown as EntryClient;
}

describe('placeEntry', () => {
  test('coloca limit buy IOC capada y normaliza el fill (fee en base)', async () => {
    let captured: unknown[] = [];
    const c = client({ id: '777', filled: 0.01, average: 100.04, fee: { cost: 0.00001, currency: 'BTC' } }, (a) => { captured = a; });
    const r = await placeEntry(c, { symbol: 'BTC/USDT', size: 0.01, refPrice: 100, slippageBps: 5, clientOrderId: 'sig-1' });
    expect(r).toEqual({ belowMin: false, filledQty: 0.01, avgPrice: 100.04, fee: 0.00001, feeBase: 0.00001, exchangeOrderId: '777' });
    // cap = 100·1.0005 = 100.05 (priceToPrecision → "100.05" → Number → 100.05); IOC
    expect(captured[0]).toBe('BTC/USDT'); expect(captured[1]).toBe('limit'); expect(captured[2]).toBe('buy');
    expect(captured[3]).toBe(0.01); expect(captured[4]).toBe(100.05);
    // El último argumento de createOrder son los params: debe incluir IOC + clientOrderId determinista.
    const params = captured[5];
    expect(params).toMatchObject({ timeInForce: 'IOC', clientOrderId: 'sig-1' });
  });

  test('size por debajo del mínimo de notional → { belowMin: true } sin tocar el exchange', async () => {
    const c = client({});
    const r = await placeEntry(c, { symbol: 'BTC/USDT', size: 0.00001, refPrice: 100, slippageBps: 5, clientOrderId: 'sig-1' }); // notional 0.001 < 1 (cost.min)
    expect(r).toEqual({ belowMin: true });
    expect(c.createOrder).not.toHaveBeenCalled();
  });

  test('fill cero (IOC no cruzó) → filledQty 0', async () => {
    const c = client({ id: '0', filled: 0, average: undefined, fee: undefined });
    const r = await placeEntry(c, { symbol: 'BTC/USDT', size: 0.01, refPrice: 100, slippageBps: 5, clientOrderId: 'sig-1' });
    expect(r).toEqual({ belowMin: false, filledQty: 0, avgPrice: 0, fee: 0, feeBase: 0, exchangeOrderId: '0' });
  });

  test('fees[] (array) → suma todos los costs (rama reduce)', async () => {
    const c = client({
      id: '888',
      filled: 0.01,
      average: 100.04,
      fees: [{ cost: 0.2, currency: 'USDT' }, { cost: 0.1, currency: 'USDT' }],
    });
    const r = await placeEntry(c, { symbol: 'BTC/USDT', size: 0.01, refPrice: 100, slippageBps: 5, clientOrderId: 'sig-1' });
    if (r.belowMin) throw new Error('no debería ser belowMin');
    expect(r.fee).toBeCloseTo(0.3);
  });
});
