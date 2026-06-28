import { describe, test, expect } from 'vitest';
import { createShutdown, type ShutdownDeps } from './shutdown.ts';

function deps(over: Partial<ShutdownDeps> = {}): { d: ShutdownDeps; calls: string[]; exits: number[] } {
  const calls: string[] = [];
  const exits: number[] = [];
  const d: ShutdownDeps = {
    closeables: [{ close: async () => { calls.push('w1'); } }, { close: async () => { calls.push('w2'); } }],
    closeConnection: async () => { calls.push('conn'); },
    closePool: async () => { calls.push('pool'); },
    exit: (c) => { exits.push(c); },
    log: () => {},
    timeoutMs: 1000,
    setTimer: () => ({ clear: () => {} }),
    ...over,
  };
  return { d, calls, exits };
}

describe('createShutdown', () => {
  test('cierra closeables, conexión y pool en orden, y sale 0', async () => {
    const { d, calls, exits } = deps();
    await createShutdown(d)();
    expect(calls).toEqual(['w1', 'w2', 'conn', 'pool']);
    expect(exits).toEqual([0]);
  });

  test('idempotente: una segunda llamada no recierra', async () => {
    let n = 0;
    const { d, exits } = deps({ closeables: [{ close: async () => { n++; } }] });
    const shutdown = createShutdown(d);
    await shutdown();
    await shutdown();
    expect(n).toBe(1);
    expect(exits).toEqual([0]);
  });

  test('si un close falla → exit 1', async () => {
    const { d, exits } = deps({ closeables: [{ close: async () => { throw new Error('boom'); } }] });
    await createShutdown(d)();
    expect(exits).toEqual([1]);
  });
});
