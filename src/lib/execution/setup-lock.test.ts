import { describe, test, expect, vi } from 'vitest';
import { withSetupLock, NOT_ACQUIRED } from './setup-lock.ts';

function fakeClient(setReturns: (string | null)[]) {
  let i = 0;
  return {
    set: vi.fn(async () => setReturns[i++ % setReturns.length]),
    eval: vi.fn(async () => 1),
  };
}

describe('withSetupLock', () => {
  test('ejecuta fn y libera cuando adquiere (SET → OK)', async () => {
    const client = fakeClient(['OK']);
    const ran = await withSetupLock('s1', 'BTC/USDT', 'testnet', async () => 'done', { client });
    expect(ran).toBe('done');
    expect(client.set).toHaveBeenCalledOnce();
    expect(client.eval).toHaveBeenCalledOnce(); // release condicional por token
  });

  test('no ejecuta fn y devuelve NOT_ACQUIRED cuando el lock está tomado (SET → null)', async () => {
    const client = fakeClient([null]);
    const fn = vi.fn(async () => 'done');
    const r = await withSetupLock('s1', 'BTC/USDT', 'testnet', fn, { client });
    expect(r).toBe(NOT_ACQUIRED);
    expect(fn).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled(); // no soy dueño → no libero
  });

  test('fail-closed: si el cliente Redis lanza, NO ejecuta fn y propaga', async () => {
    const client = { set: vi.fn(async () => { throw new Error('redis down'); }), eval: vi.fn() };
    const fn = vi.fn(async () => 'done');
    await expect(withSetupLock('s1', 'BTC/USDT', 'testnet', fn, { client })).rejects.toThrow('redis down');
    expect(fn).not.toHaveBeenCalled();
  });

  test('libera aunque fn lance (finally)', async () => {
    const client = fakeClient(['OK']);
    await expect(withSetupLock('s1', 'BTC/USDT', 'testnet', async () => { throw new Error('boom'); }, { client }))
      .rejects.toThrow('boom');
    expect(client.eval).toHaveBeenCalledOnce();
  });

  test('un release que falla en eval no oculta el resultado de fn (best-effort)', async () => {
    const client = {
      set: vi.fn(async () => 'OK'),
      eval: vi.fn(async () => { throw new Error('redis eval failed'); }),
    };
    const result = await withSetupLock('s1', 'BTC/USDT', 'testnet', async () => 'done', { client });
    expect(result).toBe('done'); // el error de eval se traga; el TTL limpia
    expect(client.eval).toHaveBeenCalledOnce();
  });
});
