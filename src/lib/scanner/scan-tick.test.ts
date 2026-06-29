import { describe, test, expect, vi } from 'vitest';
import { runScanTick } from './scan-tick.ts';
import type { Strategy } from './types.ts';

function strat(id: string, symbols: string[]): Strategy {
  return { id, enabled: true, symbols, triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: {}, version: 1, skillName: null };
}

describe('runScanTick', () => {
  test('escanea cada símbolo de cada estrategia activa', async () => {
    const deps = {
      isPaused: async () => false,
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT']), strat('b', ['SOL/USDT'])],
      scan: vi.fn(async () => null),
      enqueue: vi.fn(async () => {}),
    };
    const res = await runScanTick(new Date('2026-03-07T00:00:00Z'), deps);
    expect(deps.scan).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ scanned: 3, fired: 0, enqueued: 0 });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  test('encola exactamente las señales que disparan', async () => {
    const scan = vi.fn(async (_s: Strategy, symbol: string) => (symbol === 'BTC/USDT' ? 'SIG-BTC' : null));
    const enqueue = vi.fn(async () => {});
    const res = await runScanTick(new Date('2026-03-07T00:00:00Z'), {
      isPaused: async () => false,
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT'])], scan, enqueue,
    });
    expect(res).toEqual({ scanned: 2, fired: 1, enqueued: 1 });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('SIG-BTC');
  });

  test('un fallo de scan en un símbolo no aborta el resto del tick (onError inyectado, sin DB)', async () => {
    const scan = vi.fn(async (_s: Strategy, symbol: string) => {
      if (symbol === 'BTC/USDT') throw new Error('boom');
      return 'SIG-ETH';
    });
    const enqueue = vi.fn(async () => {});
    const onError = vi.fn(async () => {});
    const res = await runScanTick(new Date('2026-03-07T00:00:00Z'), {
      isPaused: async () => false,
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT'])], scan, enqueue, onError,
    });
    expect(res.scanned).toBe(2);
    expect(res.enqueued).toBe(1);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('SIG-ETH');
    expect(onError).toHaveBeenCalledExactlyOnceWith('a', 'BTC/USDT', expect.any(Error));
  });

  test('un fallo de enqueue no aborta el tick; onEnqueueError se llama con signalId y fired > enqueued', async () => {
    // BTC dispara señal pero enqueue falla; ETH dispara señal y encola OK.
    const scan = vi.fn(async (_s: Strategy, symbol: string) =>
      symbol === 'BTC/USDT' ? 'SIG-BTC' : 'SIG-ETH',
    );
    const enqueue = vi.fn(async (signalId: string) => {
      if (signalId === 'SIG-BTC') throw new Error('Redis caído');
    });
    const onError = vi.fn(async () => {});
    const onEnqueueError = vi.fn(async () => {});
    const res = await runScanTick(new Date('2026-03-07T00:00:00Z'), {
      isPaused: async () => false,
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT'])],
      scan,
      enqueue,
      onError,
      onEnqueueError,
    });
    // Ambos símbolos escaneados; ambas señales disparadas; solo ETH encolada.
    expect(res).toEqual({ scanned: 2, fired: 2, enqueued: 1 });
    // scan_error no se llama — el fallo fue en enqueue, no en scan.
    expect(onError).not.toHaveBeenCalled();
    // enqueue_error se llama con los args correctos, incluido signalId.
    expect(onEnqueueError).toHaveBeenCalledExactlyOnceWith('a', 'BTC/USDT', 'SIG-BTC', expect.any(Error));
  });

  test('pausado → no recorre estrategias, retorna ceros y audita scan_paused', async () => {
    const getStrategies = vi.fn(async () => []);
    const onError = vi.fn(async () => {});
    const result = await runScanTick(new Date('2026-06-29T00:00:00Z'), {
      isPaused: async () => true, getStrategies, scan: vi.fn(), enqueue: vi.fn(), onError, onEnqueueError: vi.fn(),
    });
    expect(result).toEqual({ scanned: 0, fired: 0, enqueued: 0 });
    expect(getStrategies).not.toHaveBeenCalled();
  });
});
