import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fetchNews, _clearNewsCache } from './news.ts';

const NOW = Date.parse('2026-06-29T12:00:00Z');

// RSS 2.0 mínimo (estructura real de CoinTelegraph: <item> con <title>/<pubDate>/<link>; CDATA en títulos).
const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<item><title><![CDATA[Bitcoin ETF aprobado por el regulador]]></title><pubDate>Mon, 29 Jun 2026 11:00:00 +0000</pubDate><link>https://x/btc1</link></item>
<item><title>Ethereum upgrade goes live</title><pubDate>Mon, 29 Jun 2026 10:00:00 +0000</pubDate><link>https://x/eth1</link></item>
<item><title>Bitcoin price stable (viejo, fuera de ventana)</title><pubDate>Sat, 27 Jun 2026 00:00:00 +0000</pubDate><link>https://x/btc-old</link></item>
<item><title>Solana sube tras una actualización de red</title><pubDate>Mon, 29 Jun 2026 11:30:00 +0000</pubDate><link>https://x/sol</link></item>
</channel></rss>`;

function rssResponse() {
  return { ok: true, status: 200, text: async () => RSS } as unknown as Response;
}

beforeEach(() => { _clearNewsCache(); });

describe('fetchNews (RSS)', () => {
  test('BTC: solo titulares de Bitcoin dentro de la ventana; ok=true', async () => {
    const fetchImpl = vi.fn(async () => rssResponse());
    const r = await fetchNews('BTC/USDT', { now: NOW, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.items.map((i) => i.title)).toEqual(['Bitcoin ETF aprobado por el regulador']); // CDATA decodificado; viejo y no-BTC filtrados
    expect(r.items[0].url).toBe('https://x/btc1');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test('ETH: filtra por la moneda base correcta', async () => {
    const r = await fetchNews('ETH/USDT', { now: NOW, fetchImpl: async () => rssResponse() });
    expect(r.items.map((i) => i.title)).toEqual(['Ethereum upgrade goes live']);
  });

  test('HTTP no-ok → { items: [], ok: false }', async () => {
    const r = await fetchNews('BTC/USDT', { now: NOW, fetchImpl: async () => ({ ok: false, status: 503 } as unknown as Response) });
    expect(r).toEqual({ items: [], ok: false });
  });

  test('fetch lanza → { items: [], ok: false } (best-effort, no propaga)', async () => {
    const r = await fetchNews('BTC/USDT', { now: NOW, fetchImpl: async () => { throw new Error('red caída'); } });
    expect(r).toEqual({ items: [], ok: false });
  });

  test('caché: segundo fetch dentro del TTL no vuelve a llamar a fetchImpl', async () => {
    const fetchImpl = vi.fn(async () => rssResponse());
    await fetchNews('BTC/USDT', { now: NOW, fetchImpl });
    const r2 = await fetchNews('BTC/USDT', { now: NOW + 60_000, fetchImpl });
    expect(r2.items.length).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce(); // servido del caché
  });

  test('alt sin titulares que la mencionen → items vacíos pero ok=true (no es fallo de fetch)', async () => {
    const r = await fetchNews('XRP/USDT', { now: NOW, fetchImpl: async () => rssResponse() });
    expect(r).toEqual({ items: [], ok: true });
  });
});
