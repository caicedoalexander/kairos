import { describe, test, expect, vi } from 'vitest';
import { runMonitorTick, type MonitorTickDeps } from './monitor-tick.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';

function pos(id: string, over: Partial<OpenPosition> = {}): OpenPosition {
  return { id, symbol: 'BTC/USDT', strategyId: 's1', decisionId: 'd1', entry: 100, size: 1, sl: 95, tp: 110, entryFee: 0.1, triggerTimeframe: '15m', mode: 'sim', openedAt: new Date('2026-03-12T00:00:00Z'), ...over };
}
function deps(over: Partial<MonitorTickDeps> = {}): MonitorTickDeps {
  return {
    getOpenPositions: async () => [pos('p1')],
    getBars: async () => [{ open: 100, high: 101, low: 90, close: 96 }],  // toca SL (low 90 <= 95)
    closeOnBracket: vi.fn(async () => true),
    notify: vi.fn(async () => ({ messageId: 'm' })),
    onError: vi.fn(async () => {}),
    simParams: DEFAULT_SIM_PARAMS,
    mode: 'sim',
    ...over,
  };
}

describe('runMonitorTick', () => {
  test('vela que toca SL → cierra y notifica', async () => {
    const d = deps();
    const r = await runMonitorTick(new Date('2026-03-12T00:00:00Z'), d);
    expect(r).toEqual({ checked: 1, closed: 1 });
    expect(d.closeOnBracket).toHaveBeenCalledOnce();
    expect(d.notify).toHaveBeenCalledOnce();
  });

  test('vela que no toca SL/TP → no cierra ni notifica', async () => {
    const d = deps({ getBars: async () => [{ open: 100, high: 101, low: 99, close: 100 }] });
    const r = await runMonitorTick(new Date(), d);
    expect(r).toEqual({ checked: 1, closed: 0 });
    expect(d.notify).not.toHaveBeenCalled();
  });

  test('sin vela disponible → skip silencioso', async () => {
    const d = deps({ getBars: async () => [] });
    const r = await runMonitorTick(new Date(), d);
    expect(r.closed).toBe(0);
  });

  test('closeOnBracket false (ya cerrada) → no notifica', async () => {
    const d = deps({ closeOnBracket: vi.fn(async () => false) });
    const r = await runMonitorTick(new Date(), d);
    expect(r.closed).toBe(0);
    expect(d.notify).not.toHaveBeenCalled();
  });

  test('error en una posición se aísla y se reporta; el tick sigue', async () => {
    const d = deps({
      getOpenPositions: async () => [pos('p1'), pos('p2')],
      getBars: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))                                   // p1 falla
        .mockResolvedValueOnce([{ open: 100, high: 101, low: 90, close: 96 }]),    // p2 toca SL
      onError: vi.fn(async () => {}),
    });
    const r = await runMonitorTick(new Date(), d);
    expect(d.onError).toHaveBeenCalledOnce();
    expect(r.checked).toBe(2);
    expect(r.closed).toBe(1);
  });
});
