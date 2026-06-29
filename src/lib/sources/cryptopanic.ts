// src/lib/sources/cryptopanic.ts
// Cliente best-effort de CryptoPanic (free tier). Devuelve { items, ok }: 'ok' distingue
// "sin noticias" de "fetch fallido" (H2). La API key se lee en closure, NUNCA entra al input del
// modelo (línea roja de credenciales). Caché in-memory por moneda base para no quemar la cuota free (M1).
export interface NewsItem { title: string; publishedAt: string; kind: string; url: string; }
export interface NewsResult { items: NewsItem[]; ok: boolean; }

export const NEWS_WINDOW_HOURS = 12;          // ventana de "catalizador reciente" (vive SOLO aquí, M2)
const CACHE_TTL_OK_MS = 10 * 60 * 1000;       // éxito: 10 min
const CACHE_TTL_FAIL_MS = 60 * 1000;          // fallo: 1 min (reintenta pronto)

interface CacheEntry { result: NewsResult; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

function baseCurrency(symbol: string): string { return symbol.split('/')[0]; }

export function _clearNewsCache(): void { cache.clear(); }

interface RawPost { title?: string; published_at?: string; kind?: string; url?: string; }

export async function fetchCryptoPanicNews(
  symbol: string, opts: { now?: number; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<NewsResult> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = baseCurrency(symbol);

  const cached = cache.get(base);
  if (cached && cached.expiresAt > now) return cached.result;

  const apiKey = process.env.CRYPTOPANIC_API_KEY;
  let result: NewsResult;
  if (!apiKey) {
    result = { items: [], ok: false };
  } else {
    try {
      const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&currencies=${base}&public=true`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`CryptoPanic respondió ${res.status}`);
      const data = (await res.json()) as { results?: RawPost[] };
      const cutoff = now - NEWS_WINDOW_HOURS * 3600_000;
      const items: NewsItem[] = (data.results ?? [])
        .filter((p) => p.published_at != null && Date.parse(p.published_at) >= cutoff)
        .map((p) => ({ title: p.title ?? '', publishedAt: p.published_at as string, kind: p.kind ?? 'news', url: p.url ?? '' }))
        .filter((i) => i.title.length > 0);
      result = { items, ok: true };
    } catch {
      result = { items: [], ok: false };
    }
  }
  cache.set(base, { result, expiresAt: now + (result.ok ? CACHE_TTL_OK_MS : CACHE_TTL_FAIL_MS) });
  return result;
}
