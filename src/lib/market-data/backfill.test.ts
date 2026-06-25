import { describe, test, expect, vi } from 'vitest';
import ccxt from 'ccxt';
import { withRetry, backfillCursor, startFrom, type CursorSource } from './backfill.ts';

const noSleep = async () => {};

describe('withRetry', () => {
  test('reintenta NetworkError y termina devolviendo el valor', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new ccxt.NetworkError('temporal');
      return 'ok';
    });
    expect(await withRetry(fn, noSleep)).toBe('ok');
    expect(calls).toBe(2);
  });

  test('no reintenta errores que no son de red (falla fuerte)', async () => {
    const fn = vi.fn(async () => { throw new Error('contrato roto'); });
    await expect(withRetry(fn, noSleep)).rejects.toThrow('contrato roto');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('startFrom', () => {
  test('reanuda desde el último guardado + step', () => {
    expect(startFrom(new Date(10_000), 500, 1_000_000)).toBe(10_500);
  });
  test('arranca en frío (antes de now) cuando no hay nada', () => {
    const now = 1_000_000_000_000;
    expect(startFrom(null, 500, now)).toBeLessThan(now);
  });
});

interface Row { ts: number }

describe('backfillCursor', () => {
  test('pagina avanzando el cursor, suma insertados y corta en página vacía', async () => {
    const pages: Row[][] = [[{ ts: 0 }, { ts: 100 }], [{ ts: 200 }], []];
    let page = 0;
    const upsert = vi.fn(async (rows: Row[]) => rows.length);
    const src: CursorSource<Row> = {
      fetchPage: async () => pages[page++] ?? [],
      upsert, cursorOf: (r) => r.ts, step: 1,
    };
    expect(await backfillCursor(src, 0, 1_000_000, noSleep)).toBe(3);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  test('corta si el cursor no avanza (evita ciclo infinito)', async () => {
    const upsert = vi.fn(async (rows: Row[]) => rows.length);
    const fetchPage = vi.fn(async () => [{ ts: 50 }]); // ts ≤ since siempre
    const src: CursorSource<Row> = { fetchPage, upsert, cursorOf: (r) => r.ts, step: 1 };
    expect(await backfillCursor(src, 100, 1_000_000, noSleep)).toBe(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
