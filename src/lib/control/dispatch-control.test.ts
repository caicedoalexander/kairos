import { describe, test, expect, vi } from 'vitest';
import { dispatchControl } from './dispatch-control.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';

const POS = { id: 'p1', strategyId: 's1', symbol: 'BTC/USDT', side: 'long', entry: 65000, size: 0.01,
  sl: 63000, tp: 68000, mode: 'sim', openedAt: new Date('2026-06-29T00:00:00Z'), triggerTimeframe: '15m', decisionId: 'd1', entryFee: 0 } as unknown as OpenPosition;

function deps(over: Record<string, unknown> = {}) {
  return { getOpenPositions: async () => [POS], setPaused: vi.fn(async () => {}), ...over } as Parameters<typeof dispatchControl>[1];
}

describe('dispatchControl', () => {
  test('estado: lista posiciones abiertas (read-only)', async () => {
    const reply = await dispatchControl({ command: 'estado' }, deps());
    expect(reply).toContain('BTC/USDT');
    expect(reply).toContain('1'); // nº de posiciones
  });
  test('estado sin posiciones', async () => {
    const reply = await dispatchControl({ command: 'estado' }, deps({ getOpenPositions: async () => [] }));
    expect(reply.toLowerCase()).toContain('sin posiciones');
  });
  test('pausa: setPaused(true) + confirma', async () => {
    const d = deps();
    const reply = await dispatchControl({ command: 'pausa' }, d);
    expect(d.setPaused).toHaveBeenCalledWith(true);
    expect(reply.toLowerCase()).toContain('pausado');
  });
  test('reanuda: setPaused(false) + confirma', async () => {
    const d = deps();
    const reply = await dispatchControl({ command: 'reanuda' }, d);
    expect(d.setPaused).toHaveBeenCalledWith(false);
    expect(reply.toLowerCase()).toContain('reanudado');
  });
  test('unknown: texto de ayuda con los comandos', async () => {
    const reply = await dispatchControl({ command: 'unknown' }, deps());
    expect(reply.toLowerCase()).toContain('/estado');
  });
});
