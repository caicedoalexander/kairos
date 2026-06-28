import { describe, test, expect, vi } from 'vitest';
import { runScanTick } from './scan-tick.ts';
import type { Strategy } from './types.ts';

function strat(id: string, symbols: string[]): Strategy {
  return { id, enabled: true, symbols, triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: {}, version: 1, skillName: null };
}

describe('runScanTick', () => {
  test('escanea cada símbolo de cada estrategia activa', async () => {
    const deps = {
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
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT'])], scan, enqueue, onError,
    });
    expect(res.scanned).toBe(2);
    expect(res.enqueued).toBe(1);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('SIG-ETH');
    expect(onError).toHaveBeenCalledExactlyOnceWith('a', 'BTC/USDT', expect.any(Error));
  });
});
