// Cliente best-effort de noticias cripto vía RSS. SIN API key, SIN cuota — más robusto que una API
// gratis con "plan" que pueden discontinuar (CryptoPanic free se dio de baja el 2026-04-01). La URL
// del feed es configurable por `NEWS_RSS_URL` (default CoinTelegraph); si un feed muere, se cambia sin
// tocar código. Devuelve { items, ok }: 'ok' distingue "sin noticias" de "fetch fallido". Caché
// in-memory por moneda base. El analista solo recibe los titulares (NewsItem) en el prompt.
export interface NewsItem { title: string; publishedAt: string; kind: string; url: string; }
export interface NewsResult { items: NewsItem[]; ok: boolean; }

export const NEWS_WINDOW_HOURS = 12;                          // ventana de "catalizador reciente" (vive SOLO aquí)
// Lazy: lee el env en cada llamada (no a nivel de módulo) para ser inmune al orden de carga de dotenv.
function rssUrl(): string { return process.env.NEWS_RSS_URL ?? 'https://cointelegraph.com/rss'; }
const CACHE_TTL_OK_MS = 10 * 60 * 1000;                       // éxito: 10 min
const CACHE_TTL_FAIL_MS = 60 * 1000;                          // fallo: 1 min (reintenta pronto)
// Major-caps (§17.2): el RSS es general, así que filtramos titulares relevantes al símbolo por palabra clave.
const KEYWORDS: Record<string, string[]> = { BTC: ['btc', 'bitcoin'], ETH: ['eth', 'ethereum'] };

interface CacheEntry { result: NewsResult; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

function baseCurrency(symbol: string): string { return symbol.split('/')[0]; }

export function _clearNewsCache(): void { cache.clear(); }

// Decodifica CDATA y las entidades XML comunes (&amp; al final para no doble-decodificar).
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

function tagOf(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1]) : null;
}

interface RawItem { title: string; pubDate: string; link: string; }
// Parser RSS tolerante por regex (sin dependencias). Un <item> mal formado se salta (best-effort).
function parseRssItems(xml: string): RawItem[] {
  return [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => ({
    title: tagOf(m[1], 'title') ?? '',
    pubDate: tagOf(m[1], 'pubDate') ?? '',
    link: tagOf(m[1], 'link') ?? '',
  }));
}

export async function fetchNews(
  symbol: string, opts: { now?: number; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<NewsResult> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = baseCurrency(symbol);

  const cached = cache.get(base);
  if (cached && cached.expiresAt > now) return cached.result;

  let result: NewsResult;
  try {
    const res = await fetchImpl(rssUrl());
    if (!res.ok) throw new Error(`RSS respondió ${res.status}`);
    const xml = await res.text();
    const cutoff = now - NEWS_WINDOW_HOURS * 3600_000;
    const keywords = KEYWORDS[base] ?? [base.toLowerCase()];
    const items: NewsItem[] = parseRssItems(xml)
      .map((i) => ({ ...i, ts: Date.parse(i.pubDate) }))   // parsea la fecha una sola vez
      .filter((i) => i.title !== '' && Number.isFinite(i.ts) && i.ts >= cutoff && keywords.some((k) => i.title.toLowerCase().includes(k)))
      .map((i) => ({ title: i.title, publishedAt: new Date(i.ts).toISOString(), kind: 'news', url: i.link }));
    result = { items, ok: true };
  } catch {
    result = { items: [], ok: false };
  }
  cache.set(base, { result, expiresAt: now + (result.ok ? CACHE_TTL_OK_MS : CACHE_TTL_FAIL_MS) });
  return result;
}
