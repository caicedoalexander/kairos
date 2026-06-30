import { describe, it, expect, vi } from 'vitest';
import ccxt from 'ccxt';
import { cancelOco, type CancelOcoClient } from './cancel-oco.ts';

const legs = [
  { id: 'sl-row', purpose: 'sl' as const, exchangeOrderId: 'X-SL', status: 'pending' },
  { id: 'tp-row', purpose: 'tp' as const, exchangeOrderId: 'X-TP', status: 'pending' },
];

describe('cancelOco', () => {
  it('con 2 legs distintas cancela AMBAS y retorna (contrato nuevo: todos los ids)', async () => {
    const cancelOrder = vi.fn(async () => ({}));
    await cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs);
    expect(cancelOrder).toHaveBeenCalledTimes(2);
    expect(cancelOrder).toHaveBeenCalledWith('X-SL', 'BTC/USDT');
    expect(cancelOrder).toHaveBeenCalledWith('X-TP', 'BTC/USDT');
  });

  it('cancela TODOS los exchangeOrderId distintos (incl. legs viejas: OrderNotFound=éxito)', async () => {
    const calls: string[] = [];
    const cancelOrder = vi.fn(async (id: string) => {
      calls.push(id);
      if (id === 'OLD-SL' || id === 'OLD-TP') throw new ccxt.OrderNotFound('gone'); // legs viejas canceladas
      return {};
    });
    const legs4 = [
      { id: 'r1', purpose: 'sl' as const, exchangeOrderId: 'OLD-SL', status: 'canceled' },
      { id: 'r2', purpose: 'tp' as const, exchangeOrderId: 'OLD-TP', status: 'canceled' },
      { id: 'r3', purpose: 'sl' as const, exchangeOrderId: 'LIVE-SL', status: 'pending' },
      { id: 'r4', purpose: 'tp' as const, exchangeOrderId: 'LIVE-TP', status: 'pending' },
    ];
    await cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs4);
    expect(calls).toEqual(expect.arrayContaining(['OLD-SL', 'OLD-TP', 'LIVE-SL', 'LIVE-TP'])); // intentó todos
  });

  it('OrderNotFound (OCO ya disparado/cancelado) = éxito (no lanza)', async () => {
    const cancelOrder = vi.fn(async () => { throw new ccxt.OrderNotFound('gone'); });
    await expect(cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs)).resolves.toBeUndefined();
  });

  it('NetworkError se propaga (el caller aborta sin tocar protected)', async () => {
    const cancelOrder = vi.fn(async () => { throw new ccxt.NetworkError('down'); });
    await expect(cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs)).rejects.toThrow(ccxt.NetworkError);
  });

  it('sin legs con exchangeOrderId → no llama cancelOrder', async () => {
    const cancelOrder = vi.fn(async () => ({}));
    await cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', [{ id: 'r', purpose: 'sl', exchangeOrderId: null, status: 'pending' }]);
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});
