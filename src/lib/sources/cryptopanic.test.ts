// src/lib/sources/cryptopanic.test.ts
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchCryptoPanicNews, _clearNewsCache } from './cryptopanic.ts';

const NOW = Date.parse('2026-06-28T12:00:00Z');
function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function post(title: string, hoursAgo: number) {
  return { title, published_at: new Date(NOW - hoursAgo * 3600_000).toISOString(), kind: 'news', url: 'https://x/' + title };
}

const prevKey = process.env.CRYPTOPANIC_API_KEY;
beforeEach(() => { _clearNewsCache(); process.env.CRYPTOPANIC_API_KEY = 'test-key'; });
afterEach(() => { if (prevKey === undefined) delete process.env.CRYPTOPANIC_API_KEY; else process.env.CRYPTOPANIC_API_KEY = prevKey; });

describe('fetchCryptoPanicNews', () => {
  test('devuelve items dentro de la ventana y filtra los viejos; ok=true', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [post('reciente', 2), post('viejo', 48)] }));
    const r = await fetchCryptoPanicNews('BTC/USDT', { now: NOW, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.items.map((i) => i.title)).toEqual(['reciente']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test('HTTP no-ok → { items: [], ok: false }', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 } as unknown as Response));
    const r = await fetchCryptoPanicNews('BTC/USDT', { now: NOW, fetchImpl });
    expect(r).toEqual({ items: [], ok: false });
  });

  test('key ausente → { items: [], ok: false } sin llamar a fetch', async () => {
    delete process.env.CRYPTOPANIC_API_KEY;
    const fetchImpl = vi.fn();
    const r = await fetchCryptoPanicNews('BTC/USDT', { now: NOW, fetchImpl });
    expect(r).toEqual({ items: [], ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('caché: segundo fetch dentro del TTL no vuelve a llamar a fetchImpl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [post('reciente', 1)] }));
    await fetchCryptoPanicNews('BTC/USDT', { now: NOW, fetchImpl });
    const r2 = await fetchCryptoPanicNews('BTC/USDT', { now: NOW + 60_000, fetchImpl });
    expect(r2.items.map((i) => i.title)).toEqual(['reciente']);
    expect(fetchImpl).toHaveBeenCalledOnce(); // servido del caché
  });
});
