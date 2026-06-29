# SP9 — Analista fundamental condicional (CryptoPanic) + skill `fundamental-read` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El decision-maker recibe un `fundamental_read` cuando hay algo que leer: el código busca noticias (CryptoPanic), un gate determinista decide, y solo entonces un subagente Haiku de solo lectura emite el read que modula el veredicto. Todo en sombra sobre `sim`.

**Architecture:** Extiende el patrón de SP8 (paso inyectable en `runDecisionMaker` + subagente + persistencia en `shadow_verdicts`) con un paso **condicional**: `isMajorCap` → `fetchNews` (best-effort, con caché) → `shouldRunFundamental` (gate) → `analyzeFundamental` (Haiku) solo si pasa. Fetch y LLM best-effort; el money path queda intacto. Deps inyectables → la suite unit no toca red ni modelo.

**Tech Stack:** TypeScript (Node target de Flue), Flue 1.0.0-beta.5 (`defineAgentProfile`/`subagents`/`session.task`), Valibot, Postgres (esquema `kairos`), Vitest, `fetch` global (CryptoPanic free tier).

**Spec:** `docs/superpowers/specs/2026-06-28-sp9-analista-fundamental-design.md` (hallazgos de revisión H1/H2/M1/M2/L1 ya incorporados).

## Global Constraints

- **Líneas rojas:** el subagente fundamental lleva `tools: []` (ninguna tool de mutación). `CRYPTOPANIC_API_KEY` se lee en closure dentro del cliente, **jamás** entra al `input` del modelo (línea roja de credenciales). El money path (`evaluateCandidate`) no se toca.
- **Verifica la API de Flue contra su doc real** (`node_modules/@flue/runtime/docs/`), nunca de memoria. Hechos ya verificados (SP8): `session.task(text, { agent, result, model }) → { data, usage, model }`; `harness.session(name?)` obtiene/crea sesión nombrada; subagente = `defineAgentProfile` en `subagents:[]`, `skills`/`tools` propios, `model`/`thinkingLevel` heredan si se omiten.
- **Best-effort en dos capas:** fetch falla (key ausente / HTTP error) → `{ items: [], ok: false }`; analista falla → `fundamental_read=null` + audit. El veredicto se emite igual. Nunca rompe el shadow ni el money path. `persist` propaga (infra), como SP7/SP8.
- **Invocación condicional:** `isMajorCap` **antes** del fetch; Haiku solo corre si el gate pasa.
- **Idempotencia sin cambios:** `jobId=signalId` + `UNIQUE(signal_id)`; los campos `fundamental_*` van en el **mismo INSERT** del veredicto.
- **Modelo del analista por env:** `FUNDAMENTAL_MODEL ?? 'anthropic/claude-haiku-4-5'`, `thinkingLevel: 'medium'` (explícitos en el profile para no heredar Sonnet/high del padre).
- **Flue descubre TODO `.ts` plano** en `src/workflows|channels|agents/` → no poner `.test.ts` ni no-workflows ahí.
- **Estilo:** funciones <50 líneas, archivos <800, inmutabilidad, validación en los límites, sin secretos hardcodeados, sin `console.log` de debug. Español en docs/comentarios; identificadores en su forma original.
- **Cobertura ≥ 80%**; `npm run typecheck` en verde (salvo estados intermedios documentados).

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/lib/reasoning/fundamental-read-schema.ts` (+test) | `FundamentalReadSchema` Valibot (con `positioning`, `decayNote` opcional) | Crear |
| `src/lib/sources/cryptopanic.ts` (+test) | Cliente HTTP best-effort `{ items, ok }`, ventana, caché TTL; tipo `NewsItem` | Crear |
| `src/lib/reasoning/fundamental-gate.ts` (+test) | `isMajorCap` + `shouldRunFundamental` puros | Crear |
| `src/lib/reasoning/analyze-fundamental.ts` (+test) | `analyzeFundamental` vía `session.task`; `FundamentalTaskSession` (clon L1) | Crear |
| `src/db/schema.sql` | 5 columnas `fundamental_*` en `shadow_verdicts` | Modificar |
| `src/db/repositories/shadow-verdicts.ts` (+test) | `ShadowVerdictRow` + INSERT/SELECT con los 5 campos | Modificar |
| `src/lib/reasoning/run-decision-maker.ts` (+test) | Paso fundamental condicional (helper) + degradación + status/fetch_ok | Modificar |
| `src/skills/fundamental-read/SKILL.md` | Doctrina del analista fundamental (§17.4/§17.5) | Crear |
| `src/skills/decision-protocol/SKILL.md` | Documenta `fundamental_read` + cómo pesarlo | Modificar |
| `src/workflows/decision-maker.ts` | Profile `fundamental-analyst` + sesión dedicada + wiring | Modificar |

---

### Task 1: Contrato `FundamentalReadSchema`

**Files:**
- Create: `src/lib/reasoning/fundamental-read-schema.ts`
- Test: `src/lib/reasoning/fundamental-read-schema.test.ts`

**Interfaces:**
- Consumes: nada (hoja).
- Produces: `FundamentalReadSchema`, `type FundamentalRead`, `parseFundamentalRead(raw): FundamentalRead`. Campos: `bias: 'bullish'|'neutral'|'bearish'`; `catalysts: Array<{ title: string(min1); sentiment: 'bullish'|'neutral'|'bearish'; relevance: 'high'|'medium'|'low' }>`; `positioning: 'crowded_long'|'crowded_short'|'neutral'`; `decayNote?: string(min1)` (opcional); `confidence: 'alta'|'media'|'baja'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reasoning/fundamental-read-schema.test.ts
import { describe, test, expect } from 'vitest';
import { parseFundamentalRead } from './fundamental-read-schema.ts';

const CON_CATALIZADOR = {
  bias: 'bearish',
  catalysts: [{ title: 'Exchange hackeado', sentiment: 'bearish', relevance: 'high' }],
  positioning: 'crowded_long',
  decayNote: 'Hace 20 min, aún caliente',
  confidence: 'alta',
};

const POSITIONING_ONLY = {
  bias: 'neutral',
  catalysts: [],
  positioning: 'crowded_short',
  confidence: 'media',
};

describe('FundamentalReadSchema', () => {
  test('acepta un read con catalizador y decayNote', () => {
    expect(parseFundamentalRead(CON_CATALIZADOR)).toEqual(CON_CATALIZADOR);
  });

  test('acepta el camino positioning-only (catalysts=[] y sin decayNote)', () => {
    expect(parseFundamentalRead(POSITIONING_ONLY)).toEqual(POSITIONING_ONLY);
  });

  test('rechaza positioning fuera del picklist', () => {
    expect(() => parseFundamentalRead({ ...POSITIONING_ONLY, positioning: 'moon' })).toThrow();
  });

  test('rechaza un catalyst con title vacío', () => {
    expect(() => parseFundamentalRead({ ...CON_CATALIZADOR, catalysts: [{ title: '', sentiment: 'bullish', relevance: 'low' }] })).toThrow();
  });

  test('rechaza decayNote vacío cuando está presente', () => {
    expect(() => parseFundamentalRead({ ...CON_CATALIZADOR, decayNote: '' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reasoning/fundamental-read-schema.test.ts`
Expected: FAIL — `Cannot find module './fundamental-read-schema.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/reasoning/fundamental-read-schema.ts
import * as v from 'valibot';

// Lectura fundamental del subagente (§17.4/§17.5). Centrada en catalizadores (CryptoPanic) +
// posicionamiento (funding/OI ya en el snapshot). El analista JUZGA noticias y derivados, no calcula.
export const FundamentalReadSchema = v.object({
  bias: v.picklist(['bullish', 'neutral', 'bearish']),           // sesgo macro del conjunto leído
  catalysts: v.array(v.object({                                  // [] si no hay catalizador relevante
    title: v.pipe(v.string(), v.minLength(1)),
    sentiment: v.picklist(['bullish', 'neutral', 'bearish']),
    relevance: v.picklist(['high', 'medium', 'low']),
  })),
  positioning: v.picklist(['crowded_long', 'crowded_short', 'neutral']),  // lectura de funding/OI (§17.4)
  decayNote: v.optional(v.pipe(v.string(), v.minLength(1))),     // §17.5: frescura; ausente si catalysts=[]
  confidence: v.picklist(['alta', 'media', 'baja']),
});

export type FundamentalRead = v.InferOutput<typeof FundamentalReadSchema>;

export function parseFundamentalRead(raw: unknown): FundamentalRead {
  return v.parse(FundamentalReadSchema, raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reasoning/fundamental-read-schema.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/fundamental-read-schema.ts src/lib/reasoning/fundamental-read-schema.test.ts
git commit -m "feat: FundamentalReadSchema (contrato Valibot del analista fundamental, SP9)"
```

---

### Task 2: Cliente CryptoPanic (best-effort + caché)

**Files:**
- Create: `src/lib/sources/cryptopanic.ts`
- Test: `src/lib/sources/cryptopanic.test.ts`

**Interfaces:**
- Consumes: nada (hoja). Lee `process.env.CRYPTOPANIC_API_KEY`.
- Produces: `interface NewsItem { title: string; publishedAt: string; kind: string; url: string }`; `interface NewsResult { items: NewsItem[]; ok: boolean }`; `const NEWS_WINDOW_HOURS = 12`; `fetchCryptoPanicNews(symbol: string, opts?: { now?: number; fetchImpl?: typeof globalThis.fetch }): Promise<NewsResult>`; `_clearNewsCache(): void` (para tests). Tarea 3 consume `NewsItem`; Tarea 6 consume `fetchCryptoPanicNews`/`NewsItem`/`NewsResult`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sources/cryptopanic.test.ts`
Expected: FAIL — `Cannot find module './cryptopanic.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sources/cryptopanic.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sources/cryptopanic.ts src/lib/sources/cryptopanic.test.ts
git commit -m "feat: cliente CryptoPanic best-effort con caché (SP9)"
```

---

### Task 3: Gate determinista (`fundamental-gate.ts`)

**Files:**
- Create: `src/lib/reasoning/fundamental-gate.ts`
- Test: `src/lib/reasoning/fundamental-gate.test.ts`

**Interfaces:**
- Consumes: `NewsItem` (Task 2); `IndicatorSnapshot` de `../scanner/types.ts` (campo `derivatives: { fundingZ: number|null; oiChangePct: number|null }`).
- Produces: `isMajorCap(symbol: string): boolean`; `shouldRunFundamental(news: NewsItem[], snapshot: IndicatorSnapshot): boolean`. Tarea 6 consume ambas.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reasoning/fundamental-gate.test.ts
import { describe, test, expect } from 'vitest';
import { isMajorCap, shouldRunFundamental } from './fundamental-gate.ts';
import type { IndicatorSnapshot } from '../scanner/types.ts';
import type { NewsItem } from '../sources/cryptopanic.ts';

const NEWS: NewsItem[] = [{ title: 'x', publishedAt: '2026-06-28T11:00:00Z', kind: 'news', url: 'u' }];
function snap(fundingZ: number | null, oiChangePct: number | null): IndicatorSnapshot {
  return { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ, oiChangePct } };
}

describe('isMajorCap', () => {
  test('BTC y ETH son major-caps; las alts no', () => {
    expect(isMajorCap('BTC/USDT')).toBe(true);
    expect(isMajorCap('ETH/USDT')).toBe(true);
    expect(isMajorCap('SOL/USDT')).toBe(false);
  });
});

describe('shouldRunFundamental', () => {
  test('catalizador en ventana → true (sin importar derivados)', () => {
    expect(shouldRunFundamental(NEWS, snap(null, null))).toBe(true);
  });
  test('sin noticias pero funding extremo → true', () => {
    expect(shouldRunFundamental([], snap(2.4, null))).toBe(true);
  });
  test('sin noticias pero OI extremo → true', () => {
    expect(shouldRunFundamental([], snap(null, 15))).toBe(true);
  });
  test('sin noticias y derivados normales → false', () => {
    expect(shouldRunFundamental([], snap(0.5, 3))).toBe(false);
  });
  test('sin noticias y derivados null → false', () => {
    expect(shouldRunFundamental([], snap(null, null))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reasoning/fundamental-gate.test.ts`
Expected: FAIL — `Cannot find module './fundamental-gate.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/reasoning/fundamental-gate.ts
import type { IndicatorSnapshot } from '../scanner/types.ts';
import type { NewsItem } from '../sources/cryptopanic.ts';

const MAJOR_CAPS = new Set(['BTC', 'ETH']);   // §17.2: solo major-caps (Set nombrado, fácil de extender)
const FUNDING_Z_EXTREME = 2.0;                 // |z| de funding que activa cautela fundamental
const OI_CHANGE_EXTREME_PCT = 10;              // |%| de cambio de OI que activa cautela

// base de 'BTC/USDT' → 'BTC'.
export function isMajorCap(symbol: string): boolean {
  return MAJOR_CAPS.has(symbol.split('/')[0]);
}

// El cliente CryptoPanic ya filtra a la ventana (M2), así que news.length>0 ⇒ catalizador en ventana.
// Corre el fundamental si hay catalizador O posicionamiento extremo (funding/OI del snapshot).
export function shouldRunFundamental(news: NewsItem[], snapshot: IndicatorSnapshot): boolean {
  const hasCatalyst = news.length > 0;
  const d = snapshot.derivatives;
  const extreme =
    (d.fundingZ != null && Math.abs(d.fundingZ) >= FUNDING_Z_EXTREME) ||
    (d.oiChangePct != null && Math.abs(d.oiChangePct) >= OI_CHANGE_EXTREME_PCT);
  return hasCatalyst || extreme;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reasoning/fundamental-gate.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/fundamental-gate.ts src/lib/reasoning/fundamental-gate.test.ts
git commit -m "feat: gate determinista del fundamental (isMajorCap + shouldRunFundamental, SP9)"
```

---

### Task 4: `analyzeFundamental` (delegación al subagente)

**Files:**
- Create: `src/lib/reasoning/analyze-fundamental.ts`
- Test: `src/lib/reasoning/analyze-fundamental.test.ts`

**Interfaces:**
- Consumes: `FundamentalReadSchema`/`FundamentalRead` (Task 1); `extractTokens` de `evaluate-with-failover.ts`.
- Produces: `interface FundamentalTaskSession { task(text, { agent, result, model? }): Promise<{ data: FundamentalRead; usage: unknown; model: { provider: string; id: string } }> }` (clon tipado a `FundamentalRead`, L1); `analyzeFundamental(session: FundamentalTaskSession, args: Record<string, unknown>, model?: string): Promise<{ read: FundamentalRead; modelUsed: string; tokens: number | null }>`. Tarea 6 consume `analyzeFundamental`; Tarea 7 implementa `FundamentalTaskSession` con `harness.session('fundamental')`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reasoning/analyze-fundamental.test.ts
import { describe, test, expect, vi } from 'vitest';
import { analyzeFundamental, type FundamentalTaskSession } from './analyze-fundamental.ts';
import { FundamentalReadSchema, type FundamentalRead } from './fundamental-read-schema.ts';

const READ: FundamentalRead = {
  bias: 'bearish', catalysts: [{ title: 'hack', sentiment: 'bearish', relevance: 'high' }],
  positioning: 'crowded_long', decayNote: 'reciente', confidence: 'alta',
};

function fakeSession(over: Partial<FundamentalTaskSession> = {}): FundamentalTaskSession {
  return {
    task: vi.fn(async () => ({ data: READ, usage: { totalTokens: 333 }, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } })),
    ...over,
  };
}

describe('analyzeFundamental', () => {
  test('delega a fundamental-analyst con el schema exacto y mapea read/modelUsed/tokens', async () => {
    const s = fakeSession();
    const out = await analyzeFundamental(s, { symbol: 'BTC/USDT', news: [] }, 'anthropic/claude-haiku-4-5');
    expect(out.read).toEqual(READ);
    expect(out.modelUsed).toBe('anthropic/claude-haiku-4-5');
    expect(out.tokens).toBe(333);
    expect(s.task).toHaveBeenCalledWith(
      expect.stringContaining('BTC/USDT'),
      expect.objectContaining({ agent: 'fundamental-analyst', model: 'anthropic/claude-haiku-4-5', result: FundamentalReadSchema }),
    );
  });

  test('propaga el error del task (la degradación la maneja el llamador)', async () => {
    const s = fakeSession({ task: async () => { throw new Error('haiku caído'); } });
    await expect(analyzeFundamental(s, { symbol: 'X' })).rejects.toThrow('haiku caído');
  });

  test('tokens null cuando usage no trae totalTokens', async () => {
    const s = fakeSession({ task: async () => ({ data: READ, usage: {}, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } }) });
    const out = await analyzeFundamental(s, { symbol: 'X' });
    expect(out.tokens).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reasoning/analyze-fundamental.test.ts`
Expected: FAIL — `Cannot find module './analyze-fundamental.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/reasoning/analyze-fundamental.ts
import { FundamentalReadSchema, type FundamentalRead } from './fundamental-read-schema.ts';
import { extractTokens } from './evaluate-with-failover.ts';

// Interfaz mínima de la sesión para delegar al subagente fundamental. CLON (L1) de la TaskSession de
// analyze-technical, tipada a FundamentalRead (no se reutiliza literal: daría mismatch de tipos).
export interface FundamentalTaskSession {
  task(text: string, opts: { agent: string; result: unknown; model?: string }): Promise<{
    data: FundamentalRead;
    usage: unknown;
    model: { provider: string; id: string };
  }>;
}

// El subagente recibe las noticias + derivados en el texto del prompt; su skill `fundamental-read`
// le dice CÓMO leerlos (catalizador vs ruido, decaimiento, posicionamiento). Juzga, no calcula.
export async function analyzeFundamental(
  session: FundamentalTaskSession, args: Record<string, unknown>, model?: string, // si se omite, usa el modelo del profile
): Promise<{ read: FundamentalRead; modelUsed: string; tokens: number | null }> {
  const text =
    'Evalúa la lectura fundamental de este candidato (noticias + posicionamiento) y emite el ' +
    'fundamental_read estructurado según el protocolo del skill fundamental-read.\n\nDatos:\n' +
    JSON.stringify(args);
  const res = await session.task(text, { agent: 'fundamental-analyst', result: FundamentalReadSchema, model });
  return { read: res.data, modelUsed: `${res.model.provider}/${res.model.id}`, tokens: extractTokens(res.usage) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reasoning/analyze-fundamental.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/analyze-fundamental.ts src/lib/reasoning/analyze-fundamental.test.ts
git commit -m "feat: analyzeFundamental delega al subagente fundamental vía session.task (SP9)"
```

---

### Task 5: Persistencia del `fundamental_read` en `shadow_verdicts`

**Files:**
- Modify: `src/db/schema.sql` (tabla `shadow_verdicts`, líneas 30-47)
- Modify: `src/db/repositories/shadow-verdicts.ts`
- Test: `src/db/repositories/shadow-verdicts.test.ts` (integración, toca Postgres)

**Interfaces:**
- Consumes: nada de tareas previas (los campos se guardan como columnas; `fundamentalRead` es `unknown`/`jsonb`).
- Produces: `ShadowVerdictRow` extendido con `fundamentalRead: unknown | null`, `fundamentalModel: string | null`, `fundamentalTokens: number | null`, `fundamentalStatus: string | null`, `fundamentalFetchOk: boolean | null`. `insertShadowVerdict`/`getShadowVerdict` manejan los 5. Tarea 6 construye este row.

> **Nota:** `src/db/migrate.test.ts` valida nombres de tabla (no columnas) → no se toca.

- [ ] **Step 1: Write the failing test (extiende el round-trip)**

En `src/db/repositories/shadow-verdicts.test.ts`, reemplaza el test `'insert + get round-trip; isAlreadyEvaluated'` por esta versión y añade el caso `skipped`:

```ts
  test('insert + get round-trip; isAlreadyEvaluated', async () => {
    const signalId = await seedSignal();
    expect(await isAlreadyEvaluated(signalId)).toBe(false);
    await insertShadowVerdict({
      signalId, verdict: { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' },
      confianza: 'media', razonamiento: 'x', modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 1234,
      technicalRead: { bias: 'bullish' }, technicalModel: 'anthropic/claude-haiku-4-5', technicalTokens: 321,
      fundamentalRead: { bias: 'bearish', catalysts: [], positioning: 'crowded_long', confidence: 'alta' },
      fundamentalModel: 'anthropic/claude-haiku-4-5', fundamentalTokens: 222, fundamentalStatus: 'ran', fundamentalFetchOk: true,
    });
    expect(await isAlreadyEvaluated(signalId)).toBe(true);
    const row = await getShadowVerdict(signalId);
    expect((row?.fundamentalRead as { bias: string }).bias).toBe('bearish');
    expect(row?.fundamentalModel).toBe('anthropic/claude-haiku-4-5');
    expect(row?.fundamentalTokens).toBe(222);
    expect(row?.fundamentalStatus).toBe('ran');
    expect(row?.fundamentalFetchOk).toBe(true);
  });

  test('fundamental omitido: read null + status + fetch_ok null se persisten', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict({
      signalId, verdict: {}, confianza: 'baja', razonamiento: null, modelUsed: 'm', tokens: null,
      technicalRead: null, technicalModel: null, technicalTokens: null,
      fundamentalRead: null, fundamentalModel: null, fundamentalTokens: null,
      fundamentalStatus: 'skipped_not_major', fundamentalFetchOk: null,
    });
    const row = await getShadowVerdict(signalId);
    expect(row?.fundamentalRead).toBeNull();
    expect(row?.fundamentalStatus).toBe('skipped_not_major');
    expect(row?.fundamentalFetchOk).toBeNull();
  });
```

Y en el test `'ON CONFLICT DO NOTHING...'`, añade los 5 campos nuevos a ambas llamadas `insertShadowVerdict` (`fundamentalRead: null, fundamentalModel: null, fundamentalTokens: null, fundamentalStatus: null, fundamentalFetchOk: null`) para que compile.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/shadow-verdicts.test.ts`
Expected: FAIL — error de tipo (`fundamentalRead` no existe en `ShadowVerdictRow`) o columna inexistente.

- [ ] **Step 3: Modify `schema.sql`**

Reemplaza el bloque `shadow_verdicts` (líneas 30-47) por esta versión con las 5 columnas nuevas en el CREATE y los ALTER idempotentes:

```sql
CREATE TABLE IF NOT EXISTS kairos.shadow_verdicts (
  id                 text PRIMARY KEY,
  signal_id          text NOT NULL REFERENCES kairos.signals(id),
  verdict            jsonb NOT NULL,
  confianza          text NOT NULL,
  razonamiento       text,
  model_used         text,
  tokens             integer,
  technical_read     jsonb,      -- TechnicalRead del analista; null si degradado
  technical_model    text,       -- model.provider/id del analista
  technical_tokens   integer,    -- usage del analista
  fundamental_read   jsonb,      -- FundamentalRead; null si no corrió (SP9)
  fundamental_model  text,
  fundamental_tokens integer,
  fundamental_status text,       -- ran | skipped_not_major | skipped_quiet | skipped_fetch_failed | failed
  fundamental_fetch_ok boolean,  -- salud del fetch (null = no se intentó)
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id)
);
-- Upgrade idempotente para DBs creadas antes de SP8:
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS technical_read   jsonb;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS technical_model  text;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS technical_tokens integer;
-- Upgrade idempotente para DBs creadas antes de SP9:
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS fundamental_read     jsonb;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS fundamental_model    text;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS fundamental_tokens   integer;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS fundamental_status   text;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS fundamental_fetch_ok boolean;
```

- [ ] **Step 4: Modify the repo**

Reemplaza `src/db/repositories/shadow-verdicts.ts` por:

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface ShadowVerdictRow {
  signalId: string;
  verdict: unknown;
  confianza: string;
  razonamiento: string | null;
  modelUsed: string | null;
  tokens: number | null;
  technicalRead: unknown | null;
  technicalModel: string | null;
  technicalTokens: number | null;
  fundamentalRead: unknown | null;
  fundamentalModel: string | null;
  fundamentalTokens: number | null;
  fundamentalStatus: string | null;
  fundamentalFetchOk: boolean | null;
}

// Append-first; ON CONFLICT (signal_id) DO NOTHING hace la inserción idempotente ante carreras.
// Los reads van en el MISMO INSERT del veredicto (no hay segunda fila ni segunda capa).
export async function insertShadowVerdict(row: ShadowVerdictRow, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.shadow_verdicts
       (id, signal_id, verdict, confianza, razonamiento, model_used, tokens,
        technical_read, technical_model, technical_tokens,
        fundamental_read, fundamental_model, fundamental_tokens, fundamental_status, fundamental_fetch_ok)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (signal_id) DO NOTHING`,
    [ulid(), row.signalId, JSON.stringify(row.verdict), row.confianza, row.razonamiento, row.modelUsed, row.tokens,
     row.technicalRead === null ? null : JSON.stringify(row.technicalRead), row.technicalModel, row.technicalTokens,
     row.fundamentalRead === null ? null : JSON.stringify(row.fundamentalRead), row.fundamentalModel, row.fundamentalTokens,
     row.fundamentalStatus, row.fundamentalFetchOk],
  );
}

export async function isAlreadyEvaluated(signalId: string, exec: Executor = query): Promise<boolean> {
  const rows = await exec(`SELECT 1 FROM kairos.shadow_verdicts WHERE signal_id = $1 LIMIT 1`, [signalId]);
  return rows.length > 0;
}

interface ShadowRow {
  signal_id: string; verdict: unknown; confianza: string; razonamiento: string | null;
  model_used: string | null; tokens: number | null;
  technical_read: unknown | null; technical_model: string | null; technical_tokens: number | null;
  fundamental_read: unknown | null; fundamental_model: string | null; fundamental_tokens: number | null;
  fundamental_status: string | null; fundamental_fetch_ok: boolean | null;
}

export async function getShadowVerdict(signalId: string, exec: Executor = query): Promise<ShadowVerdictRow | null> {
  const rows = await exec<ShadowRow>(
    `SELECT signal_id, verdict, confianza, razonamiento, model_used, tokens,
            technical_read, technical_model, technical_tokens,
            fundamental_read, fundamental_model, fundamental_tokens, fundamental_status, fundamental_fetch_ok
       FROM kairos.shadow_verdicts WHERE signal_id = $1`,
    [signalId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    signalId: r.signal_id, verdict: r.verdict, confianza: r.confianza, razonamiento: r.razonamiento,
    modelUsed: r.model_used, tokens: r.tokens === null ? null : Number(r.tokens),
    technicalRead: r.technical_read, technicalModel: r.technical_model,
    technicalTokens: r.technical_tokens === null ? null : Number(r.technical_tokens),
    fundamentalRead: r.fundamental_read, fundamentalModel: r.fundamental_model,
    fundamentalTokens: r.fundamental_tokens === null ? null : Number(r.fundamental_tokens),
    fundamentalStatus: r.fundamental_status, fundamentalFetchOk: r.fundamental_fetch_ok,
  };
}
```

- [ ] **Step 5: Run migrate + test to verify it passes**

Run: `npm run migrate && npx vitest run src/db/repositories/shadow-verdicts.test.ts`
Expected: migrate aplica los ALTER sin error; tests PASS.

> **Estado intermedio esperado (L1):** tras este commit, `ShadowVerdictRow` tiene 5 campos
> requeridos que el `run-decision-maker.ts` de SP8 aún no provee → `npm run typecheck` **fallará**
> hasta Task 6 (que reescribe ese archivo). `npm test` (Vitest) sigue verde (no hace typecheck de
> proyecto). No corras `npm run typecheck` como gate entre Task 5 y Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/repositories/shadow-verdicts.ts src/db/repositories/shadow-verdicts.test.ts
git commit -m "feat: shadow_verdicts persiste fundamental_read/model/tokens/status/fetch_ok (SP9)"
```

---

### Task 6: Orquestación — paso fundamental condicional en `runDecisionMaker`

**Files:**
- Modify: `src/lib/reasoning/run-decision-maker.ts`
- Modify: `src/workflows/decision-maker.ts` (stubs temporales para mantener typecheck verde)
- Test: `src/lib/reasoning/run-decision-maker.test.ts`

**Interfaces:**
- Consumes: `FundamentalRead` (Task 1); `NewsItem`/`NewsResult` (Task 2); `isMajorCap`/`shouldRunFundamental` firmas (Task 3); `analyzeFundamental` retorno `{ read, modelUsed, tokens }` (Task 4); `ShadowVerdictRow` con campos `fundamental*` (Task 5).
- Produces: `DecisionMakerDeps` gana `isMajorCap: (symbol: string) => boolean`, `fetchNews: (symbol: string) => Promise<{ items: NewsItem[]; ok: boolean }>`, `shouldRunFundamental: (news: NewsItem[], snapshot: IndicatorSnapshot) => boolean`, `analyzeFundamental: (args: { symbol: string; news: NewsItem[]; derivatives: unknown }) => Promise<{ read: FundamentalRead; modelUsed: string; tokens: number | null }>`. `ShadowEvalArgs` gana `fundamental_read?: FundamentalRead | null`. Tarea 7 cablea estas deps.

- [ ] **Step 1: Write the failing tests (extiende el describe; añade el helper de deps fundamentales)**

En `src/lib/reasoning/run-decision-maker.test.ts`, añade imports y constantes de cabecera:

```ts
import type { FundamentalRead } from './fundamental-read-schema.ts';
import type { NewsItem } from '../sources/cryptopanic.ts';
const FREAD: FundamentalRead = { bias: 'bearish', catalysts: [{ title: 'hack', sentiment: 'bearish', relevance: 'high' }], positioning: 'crowded_long', decayNote: 'reciente', confidence: 'alta' };
const NEWS_ITEM: NewsItem = { title: 'hack', publishedAt: '2026-06-28T11:00:00Z', kind: 'news', url: 'u' };
```

Extiende el helper `deps()` con los 4 defaults nuevos (camino "corre el fundamental", antes del `...over`):

```ts
    isMajorCap: () => true,
    fetchNews: async () => ({ items: [NEWS_ITEM], ok: true }),
    shouldRunFundamental: () => true,
    analyzeFundamental: async () => ({ read: FREAD, modelUsed: 'anthropic/claude-haiku-4-5', tokens: 222 }),
```

Tests nuevos:

```ts
  test('major-cap con catalizador → corre el fundamental y persiste read/status=ran/fetch_ok=true', async () => {
    const d = deps();
    await runDecisionMaker('sig1', d);
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({
      fundamentalRead: FREAD, fundamentalModel: 'anthropic/claude-haiku-4-5', fundamentalTokens: 222,
      fundamentalStatus: 'ran', fundamentalFetchOk: true,
    }));
  });

  test('el fundamental_read viaja en los args de evaluate (clave snake_case)', async () => {
    const evaluate = vi.fn(async () => ({ verdict: VERDICT, modelUsed: 'm', tokens: 1 }));
    await runDecisionMaker('sig1', deps({ evaluate }));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ fundamental_read: FREAD }));
  });

  test('no major-cap → skipped_not_major, sin fetch ni LLM', async () => {
    const fetchNews = vi.fn(async () => ({ items: [], ok: true }));
    const analyzeFundamental = vi.fn();
    const d = deps({ isMajorCap: () => false, fetchNews, analyzeFundamental });
    await runDecisionMaker('sig1', d);
    expect(fetchNews).not.toHaveBeenCalled();
    expect(analyzeFundamental).not.toHaveBeenCalled();
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'skipped_not_major', fundamentalRead: null, fundamentalFetchOk: null }));
  });

  test('gate false con fetch ok → skipped_quiet', async () => {
    const d = deps({ shouldRunFundamental: () => false });
    await runDecisionMaker('sig1', d);
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'skipped_quiet', fundamentalFetchOk: true }));
  });

  test('gate false con fetch fallido → skipped_fetch_failed + audit', async () => {
    const d = deps({ fetchNews: async () => ({ items: [], ok: false }), shouldRunFundamental: () => false });
    await runDecisionMaker('sig1', d);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'fundamental_fetch_failed' }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'skipped_fetch_failed', fundamentalFetchOk: false }));
  });

  test('analista fundamental falla → status=failed + audit, veredicto se emite igual', async () => {
    const d = deps({ analyzeFundamental: async () => { throw new Error('haiku caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'fundamental_read_failed' }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'failed', fundamentalRead: null }));
  });
```

> El test técnico existente `'camino feliz: persiste verdict + technical_read/model/tokens'` sigue
> verde: el helper `deps()` ahora también provee las deps fundamentales, y `persist` se afirma con
> `objectContaining`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts`
Expected: FAIL — `isMajorCap`/`fetchNews`/… no existen en `DecisionMakerDeps`; `persist` no recibe los campos `fundamental*`.

- [ ] **Step 3: Rewrite `run-decision-maker.ts`**

Reemplaza `src/lib/reasoning/run-decision-maker.ts` por:

```ts
import type { Signal, Strategy } from '../scanner/types.ts';
import type { IndicatorSnapshot } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';
import type { NewsItem } from '../sources/cryptopanic.ts';
import type { ShadowVerdictRow } from '../../db/repositories/shadow-verdicts.ts';

export interface ShadowEvalArgs {
  symbol: string;
  snapshot: unknown;
  riskParams: Record<string, unknown>;
  timeframes: unknown;
  technical_read?: TechnicalRead | null;
  fundamental_read?: FundamentalRead | null;   // lo inyecta la orquestación tras el paso fundamental
}

type AuditFn = (entry: { eventType: string; actor: string; payload: Record<string, unknown> }) => Promise<unknown>;

export interface DecisionMakerDeps {
  getSignal: (signalId: string) => Promise<Signal | null>;
  getStrategy: (strategyId: string) => Promise<Strategy | null>;
  isAlreadyEvaluated: (signalId: string) => Promise<boolean>;
  analyze: (args: ShadowEvalArgs) => Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }>;
  isMajorCap: (symbol: string) => boolean;
  fetchNews: (symbol: string) => Promise<{ items: NewsItem[]; ok: boolean }>;
  shouldRunFundamental: (news: NewsItem[], snapshot: IndicatorSnapshot) => boolean;
  analyzeFundamental: (args: { symbol: string; news: NewsItem[]; derivatives: unknown }) => Promise<{ read: FundamentalRead; modelUsed: string; tokens: number | null }>;
  evaluate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
  persist: (row: ShadowVerdictRow) => Promise<void>;
  audit: AuditFn;
}

export type DecisionOutcome =
  | { kind: 'persisted'; verdict: LlmVerdict }
  | { kind: 'not_found' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: string };

interface FundamentalOutcome {
  read: FundamentalRead | null; model: string | null; tokens: number | null;
  status: string; fetchOk: boolean | null;
}

// Paso fundamental CONDICIONAL y best-effort (SP9). isMajorCap antes del fetch; fetch best-effort
// (fail → audit, sigue); analista solo si el gate pasa; fallo del analista → status='failed' + audit.
async function runFundamentalStep(signalId: string, signal: Signal, deps: DecisionMakerDeps): Promise<FundamentalOutcome> {
  if (!deps.isMajorCap(signal.symbol)) {
    return { read: null, model: null, tokens: null, status: 'skipped_not_major', fetchOk: null };
  }
  let news: NewsItem[] = [];
  let ok = false;
  try {
    const r = await deps.fetchNews(signal.symbol);
    news = r.items; ok = r.ok;
  } catch { ok = false; }   // fetchNews es best-effort por contrato; defensivo
  if (!ok) {
    try {
      await deps.audit({ eventType: 'fundamental_fetch_failed', actor: 'fundamental-source', payload: { signalId, symbol: signal.symbol } });
    } catch { /* best-effort */ }
  }
  if (!deps.shouldRunFundamental(news, signal.snapshot)) {
    return { read: null, model: null, tokens: null, status: ok ? 'skipped_quiet' : 'skipped_fetch_failed', fetchOk: ok };
  }
  try {
    const f = await deps.analyzeFundamental({ symbol: signal.symbol, news, derivatives: signal.snapshot.derivatives });
    return { read: f.read, model: f.modelUsed, tokens: f.tokens, status: 'ran', fetchOk: ok };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.name : 'unknown';
    try {
      await deps.audit({ eventType: 'fundamental_read_failed', actor: 'fundamental-analyst', payload: { signalId, error, errorType } });
    } catch { /* best-effort */ }
    return { read: null, model: null, tokens: null, status: 'failed', fetchOk: ok };
  }
}

// Paso técnico (SP8): lectura técnica con degradación best-effort.
async function runTechnicalStep(signalId: string, args: ShadowEvalArgs, deps: DecisionMakerDeps): Promise<{ read: TechnicalRead | null; model: string | null; tokens: number | null }> {
  try {
    const a = await deps.analyze(args);
    return { read: a.read, model: a.modelUsed, tokens: a.tokens };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.name : 'unknown';
    try {
      await deps.audit({ eventType: 'technical_read_failed', actor: 'technical-analyst', payload: { signalId, error, errorType } });
    } catch { /* best-effort */ }
    return { read: null, model: null, tokens: null };
  }
}

// Orquestación determinista del shadow eval. Pasos: carga (infra propaga) → técnico (degrada) →
// fundamental (condicional, degrada) → evaluate (decision-protocol) con los reads inyectados →
// persist. SOLO el fallo de evaluate → shadow_failed; persist propaga (infra), como SP7/SP8.
export async function runDecisionMaker(signalId: string, deps: DecisionMakerDeps): Promise<DecisionOutcome> {
  const signal = await deps.getSignal(signalId);
  if (!signal) return { kind: 'not_found' };
  if (await deps.isAlreadyEvaluated(signalId)) return { kind: 'duplicate' };
  const strategy = await deps.getStrategy(signal.strategyId);
  if (!strategy) return { kind: 'not_found' };

  const args: ShadowEvalArgs = {
    symbol: signal.symbol,
    snapshot: signal.snapshot,
    riskParams: strategy.riskParams,
    timeframes: strategy.triggerConfig.timeframes,
  };

  const tech = await runTechnicalStep(signalId, args, deps);
  const fund = await runFundamentalStep(signalId, signal, deps);

  const evalArgs: ShadowEvalArgs = { ...args, technical_read: tech.read, fundamental_read: fund.read };
  let evaluated: { verdict: LlmVerdict; modelUsed: string; tokens: number | null };
  try {
    evaluated = await deps.evaluate(evalArgs);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await deps.audit({
        eventType: 'shadow_failed', actor: 'decision-maker',
        payload: { signalId, error, technicalRead: tech.read, technicalModel: tech.model, technicalTokens: tech.tokens,
          fundamentalRead: fund.read, fundamentalStatus: fund.status },
      });
    } catch { /* best-effort */ }
    return { kind: 'failed', error };
  }

  await deps.persist({
    signalId, verdict: evaluated.verdict, confianza: evaluated.verdict.confianza,
    razonamiento: evaluated.verdict.razonamiento, modelUsed: evaluated.modelUsed, tokens: evaluated.tokens,
    technicalRead: tech.read, technicalModel: tech.model, technicalTokens: tech.tokens,
    fundamentalRead: fund.read, fundamentalModel: fund.model, fundamentalTokens: fund.tokens,
    fundamentalStatus: fund.status, fundamentalFetchOk: fund.fetchOk,
  });
  return { kind: 'persisted', verdict: evaluated.verdict };
}
```

- [ ] **Step 4: Add temporary stubs in `decision-maker.ts` (keep typecheck green)**

`DecisionMakerDeps` ahora exige 4 deps fundamentales. Para que `src/workflows/decision-maker.ts`
compile hasta Task 7, añade stubs en el objeto `deps` (justo después de `analyze:`). `isMajorCap`
devuelve `false` → el fundamental se omite en runtime (nada lo invoca entre Task 6 y Task 7; el smoke
es de Task 7):

```ts
      analyze: (args) => analyzeTechnical(techSession, args as unknown as Record<string, unknown>, TECHNICAL_MODEL),
      // SP9-Task7 reemplaza estos stubs con el cableado real (profile fundamental + sesión dedicada):
      isMajorCap: () => false,
      fetchNews: async () => ({ items: [], ok: false }),
      shouldRunFundamental: () => false,
      analyzeFundamental: async () => { throw new Error('SP9-Task7 pendiente: cableado de analyzeFundamental'); },
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts && npm run typecheck`
Expected: tests PASS (los de SP7/SP8 + los 6 nuevos); typecheck **verde** (cierra el estado intermedio de Task 5).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reasoning/run-decision-maker.ts src/lib/reasoning/run-decision-maker.test.ts src/workflows/decision-maker.ts
git commit -m "feat: runDecisionMaker corre el fundamental condicional con degradación (SP9)"
```

---

### Task 7: Cableado del workflow + skills (profile fundamental, sesión dedicada)

**Files:**
- Create: `src/skills/fundamental-read/SKILL.md`
- Modify: `src/skills/decision-protocol/SKILL.md`
- Modify: `src/workflows/decision-maker.ts`

**Interfaces:**
- Consumes: `fetchCryptoPanicNews`/`NewsResult` (Task 2); `isMajorCap`/`shouldRunFundamental` (Task 3); `analyzeFundamental`/`FundamentalTaskSession` (Task 4); `runDecisionMaker`/`DecisionMakerDeps` (Task 6).
- Produces: workflow `decision-maker` con el fundamental cableado end-to-end. Sin test unit nuevo (la lógica vive en las libs ya testeadas); se valida con `typecheck` + smoke vivo. El profile `fundamental-analyst` lleva `tools: []` (línea roja).

> Recordatorio Flue-discovery: `decision-maker.ts` es descubierto como workflow. No añadir `.test.ts` ni helpers no-workflow en `src/workflows/`. El skill nuevo vive en `src/skills/fundamental-read/`.

- [ ] **Step 1: Crear `src/skills/fundamental-read/SKILL.md`**

```markdown
---
name: fundamental-read
description: Protocolo del analista fundamental de Kairos para leer catalizadores (noticias) y posicionamiento (funding/OI) de un candidato y emitir un fundamental_read estructurado (sin recalcular nada).
---

# Lectura fundamental (Kairos)

Eres el **analista fundamental** de un bot de trading spot long-only sobre **major-caps** (BTC/ETH).
Recibes en el prompt `news` (titulares recientes de CryptoPanic ya filtrados a la ventana) y
`derivatives` (funding/OI ya computados). **No ejecutas órdenes ni recalculas nada**: lees el
contexto macro y emites un `fundamental_read`. *Juzgas, no calculas.*

## Entrada

- `symbol`: el par (p. ej. `BTC/USDT`).
- `news`: lista de `{ title, publishedAt, kind, url }` — puede venir **vacía** (sin catalizador; el
  analista se invocó por posicionamiento extremo).
- `derivatives`: `{ fundingZ, oiChangePct }` — posicionamiento del perp.

## Cómo leer

1. **Catalizador vs ruido:** un listing, hack, acción regulatoria o macro relevante es un
   catalizador; el ruido cotidiano no. Clasifica cada noticia material en `catalysts[]` con su
   `sentiment` y `relevance`. Ignora lo irrelevante (no lo metas como catalyst de baja relevancia
   solo por estar).
2. **Decaimiento temporal (§17.5):** una noticia pierde peso con el tiempo. Un hack de hace 5 min
   pesa; uno de hace 3 días, poco. Anota en `decayNote` la frescura del catalizador dominante.
   Si `catalysts` está vacío, **omite** `decayNote`.
3. **Posicionamiento:** `fundingZ` muy positivo / OI creciendo fuerte → `crowded_long` (riesgo de
   squeeze, cautela para una entrada larga). Muy negativo → `crowded_short`. Normal → `neutral`.
4. **Sesgo macro:** integra catalizadores + posicionamiento en un `bias` (bullish/neutral/bearish).
   Un catalizador bajista relevante o un `crowded_long` extremo empujan a `bearish`/cautela.

## Salida (contrato)

Emite **solo** el objeto estructurado pedido:

- `bias`: `bullish`/`neutral`/`bearish` — sesgo macro del conjunto.
- `catalysts`: lista de `{ title, sentiment, relevance }` (vacía si no hay catalizador material).
- `positioning`: `crowded_long`/`crowded_short`/`neutral`.
- `decayNote` *(opcional)*: 1 frase sobre la frescura del catalizador dominante (omítela si no hay
  catalizadores).
- `confidence`: `alta`/`media`/`baja`.

No propones niveles ni sizing: eso es del decision-maker. Tu trabajo es la **lectura macro
cualitativa**: catalizador, decaimiento y posicionamiento.
```

- [ ] **Step 2: Editar `src/skills/decision-protocol/SKILL.md` (documenta fundamental_read)**

En la sección `## Entrada (`args`)`, añade un bullet (junto al de `technical_read`):

```markdown
- `fundamental_read` *(opcional)*: lectura macro de un analista fundamental (`bias`, `catalysts[]`,
  `positioning`, `decayNote?`, `confidence`). Viene **solo** cuando había algo que leer (catalizador
  o derivados extremos en un major-cap); si no viene o es `null`, no hay señal fundamental y decide
  la técnica. Pésalo según §17.4: **catalizador bajista relevante → veto** (`action: skip` o
  `confianza: baja`); **`positioning: crowded_long` / derivados extremos → cautela** (baja
  `sizingFactor`); **catalizador alcista + posicionamiento sano → refuerzo** (`confianza` alta, el
  risk gate determinista sigue capando). No sobre-reacciones a un catalizador rancio (mira
  `decayNote`).
```

(La instrucción R1 "no delegues ni invoques ningún subagente — los reads ya vienen en `args`" ya
está en la sección `## Importante` de SP8 y cubre también al fundamental; no se duplica.)

- [ ] **Step 3: Editar `src/workflows/decision-maker.ts` (profile fundamental + sesión + wiring real)**

Reemplaza el archivo por:

```ts
import { defineAgent, defineAgentProfile, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import decisionProtocol from '../skills/decision-protocol/SKILL.md' with { type: 'skill' };
import technicalRead from '../skills/technical-read/SKILL.md' with { type: 'skill' };
import fundamentalRead from '../skills/fundamental-read/SKILL.md' with { type: 'skill' };
import { evaluateWithFailover, type SkillSession } from '../lib/reasoning/evaluate-with-failover.ts';
import { analyzeTechnical, type TaskSession } from '../lib/reasoning/analyze-technical.ts';
import { analyzeFundamental, type FundamentalTaskSession } from '../lib/reasoning/analyze-fundamental.ts';
import { isMajorCap, shouldRunFundamental } from '../lib/reasoning/fundamental-gate.ts';
import { fetchCryptoPanicNews } from '../lib/sources/cryptopanic.ts';
import { runDecisionMaker, type DecisionMakerDeps } from '../lib/reasoning/run-decision-maker.ts';
import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { insertShadowVerdict, isAlreadyEvaluated } from '../db/repositories/shadow-verdicts.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Modelos por env (§9): no hardcodear el id exacto. Failover reintenta el mismo modelo si no hay escalación.
const DECISION_MODEL = process.env.DECISION_MODEL ?? 'anthropic/claude-sonnet-4-6';
const ESCALATION = process.env.DECISION_MODEL_ESCALATION;
const MODELS = ESCALATION ? [DECISION_MODEL, ESCALATION] : [DECISION_MODEL, DECISION_MODEL];
// Analistas: Haiku, thinking medium (§287). Explícitos para NO heredar Sonnet/high del padre.
const TECHNICAL_MODEL = process.env.TECHNICAL_MODEL ?? 'anthropic/claude-haiku-4-5';
const FUNDAMENTAL_MODEL = process.env.FUNDAMENTAL_MODEL ?? 'anthropic/claude-haiku-4-5';

// Subagentes: SOLO lectura. tools:[] = línea roja (no pueden mutar dinero ni leer-con-efecto).
const technicalAnalyst = defineAgentProfile({
  name: 'technical-analyst',
  description: 'Interpreta el snapshot de indicadores ya computado y emite un technical_read cualitativo. Solo lectura.',
  model: TECHNICAL_MODEL,
  thinkingLevel: 'medium',
  skills: [technicalRead],
  tools: [],
});

const fundamentalAnalyst = defineAgentProfile({
  name: 'fundamental-analyst',
  description: 'Lee catalizadores (noticias) y posicionamiento (funding/OI) de un major-cap y emite un fundamental_read. Solo lectura.',
  model: FUNDAMENTAL_MODEL,
  thinkingLevel: 'medium',
  skills: [fundamentalRead],
  tools: [],
});

const decisionAgent = defineAgent(() => ({
  model: DECISION_MODEL,
  thinkingLevel: 'high',
  skills: [decisionProtocol],
  subagents: [technicalAnalyst, fundamentalAnalyst],
  // SIN tools de mutación: el decision-maker solo emite veredicto (línea roja).
}));

export default defineWorkflow({
  agent: decisionAgent,
  input: v.object({ signalId: v.string() }),
  output: v.object({ outcome: v.picklist(['persisted', 'not_found', 'duplicate', 'failed']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    // Sesiones dedicadas por analista (R2): transcript del decision-maker limpio. Los subagentes
    // están disponibles porque se registran en el AGENTE, no en la sesión.
    const techSession = (await harness.session('technical')) as unknown as TaskSession;
    const fundSession = (await harness.session('fundamental')) as unknown as FundamentalTaskSession;
    const deps: DecisionMakerDeps = {
      getSignal: getSignalById,
      getStrategy,
      isAlreadyEvaluated,
      analyze: (args) => analyzeTechnical(techSession, args as unknown as Record<string, unknown>, TECHNICAL_MODEL),
      isMajorCap,
      fetchNews: (symbol) => fetchCryptoPanicNews(symbol),
      shouldRunFundamental,
      analyzeFundamental: (fargs) => analyzeFundamental(fundSession, fargs as unknown as Record<string, unknown>, FUNDAMENTAL_MODEL),
      evaluate: (args) => evaluateWithFailover(session, args as unknown as Record<string, unknown>, MODELS),
      persist: insertShadowVerdict,
      audit: appendAuditLog,
    };
    const result = await runDecisionMaker(input.signalId, deps);
    return { outcome: result.kind };
  },
});
```

- [ ] **Step 4: Typecheck + suite completa**

Run: `npm run typecheck && npm test`
Expected: typecheck limpio; toda la suite verde (incluye Tasks 1-6). Cobertura ≥ 80%.

> **Verifica la línea roja antes de commitear:** confirma en el diff que `fundamentalAnalyst` lleva
> `tools: []` y que `decisionAgent` no declara tools de mutación.

- [ ] **Step 5: Commit**

```bash
git add src/skills/fundamental-read/SKILL.md src/skills/decision-protocol/SKILL.md src/workflows/decision-maker.ts
git commit -m "feat: cablea analista fundamental en decision-maker (profile + skill + sesión dedicada, SP9)"
```

- [ ] **Step 6: Smoke vivo (manual, no determinista — requiere DATABASE_URL, REDIS, ANTHROPIC_API_KEY, CRYPTOPANIC_API_KEY)**

Siembra una señal **BTC/USDT** real (major-cap, para que el gate considere el fundamental) y corre el
workflow una vez:

Run: `SHADOW_WORKER= npx flue run decision-maker --target node --input '{"signalId":"<un signalId BTC real>"}'`
Expected: el run completa con `outcome=persisted`. En `kairos.shadow_verdicts` la fila trae
`fundamental_status` (`ran` si CryptoPanic devolvió noticias o los derivados eran extremos; o
`skipped_quiet` si la ventana estaba tranquila y los derivados normales), y si corrió, un
`fundamental_read` Valibot válido + `fundamental_model`/`fundamental_tokens`. Verifica con:
`psql "$DATABASE_URL" -c "SELECT fundamental_status, fundamental_fetch_ok, fundamental_model, fundamental_read->>'bias' FROM kairos.shadow_verdicts ORDER BY created_at DESC LIMIT 1;"`

> Si CryptoPanic falla o la key no está, la fila debe traer `fundamental_fetch_ok=false` y un audit
> `fundamental_fetch_failed`, con el veredicto igualmente persistido (degradación). También es un
> resultado válido del smoke.

---

## Notas de cierre (post-implementación, fuera de los commits de tareas)

Tras Task 7, actualizar (en un commit aparte, como en SP6/SP7/SP8):
- `CLAUDE.md`: bullet SP9 (analista fundamental condicional en sombra).
- El ledger de subagent-driven-development con el estado de cada tarea.
