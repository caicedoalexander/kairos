import { describe, it, expect, vi } from 'vitest';
import ccxt from 'ccxt';
import { cancelOco, type CancelOcoClient } from './cancel-oco.ts';

const legs = [
  { id: 'sl-row', purpose: 'sl' as const, exchangeOrderId: 'X-SL', status: 'pending' },
  { id: 'tp-row', purpose: 'tp' as const, exchangeOrderId: 'X-TP', status: 'pending' },
];

describe('cancelOco', () => {
  it('cancela UNA leg (en spot cancela toda la lista) y retorna', async () => {
    const cancelOrder = vi.fn(async () => ({}));
    await cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs);
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('X-SL', 'BTC/USDT');
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
