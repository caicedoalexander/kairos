# SP1 — Market-data & almacenamiento (Fase 1 de Kairos) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poblar el histórico reproducible en Postgres (`ohlcv_candles`, `funding_rates`, `open_interest`) mediante ingesta REST idempotente vía ccxt, para que SP2 (scanner) y SP4 (backtester) lo lean.

**Architecture:** Capa de datos determinista (sin LLM, sin mutación). Funciones puras de fetch+validación (ccxt → filas), repos de upsert idempotente por PK, y un comando de backfill resumible. Las funciones testables reciben sus dependencias por inyección; solo el `main()` del CLI importa repos (dinámicamente, tras `dotenv`) para respetar el orden env-antes-de-pool ya establecido en `migrate.ts`.

**Tech Stack:** TypeScript ESM (Node ≥22.19, `--experimental-strip-types`), ccxt 4.5 (cliente público Spot + `binanceusdm` perp), Valibot (validación de límites), pg (Postgres), Vitest + v8 coverage.

## Global Constraints

Copiadas del spec (`docs/superpowers/specs/2026-06-25-kairos-fase-1-sp1-market-data-design.md`). Todo task las hereda.

- **Universo:** `SYMBOLS = ['BTC/USDT','ETH/USDT']`; **TFs:** `['15m','1h','4h']`; **backfill:** ~2 años (`BACKFILL_DAYS = 730`).
- **Datos:** OHLCV (Spot) + funding + open interest (perp USDM, read-only). Liquidaciones y WS **diferidos** (no se tocan).
- **Solo cliente público** (sin API key) en SP1. **Ninguna** tool de mutación se importa ni se usa.
- **Validación con Valibot** (no zod) en el límite ccxt. Respuesta malformada = **contrato roto → lanza** (no se descartan filas en silencio).
- **Idempotencia por PK** (`ON CONFLICT DO NOTHING`); re-correr el backfill no duplica y reanuda desde lo guardado.
- **Solo velas cerradas** en `ohlcv_candles` (descartar la vela en formación).
- **`symbol` del perp** se mapea con `toPerpSymbol` solo para la llamada ccxt; en las filas se persiste el **símbolo spot** (`BTC/USDT`), que es la clave de join con `ohlcv_candles`.
- **Verificar ccxt contra su doc/tipos reales** (ya hecho en este plan; re-confirmar si cambia la versión). Firmas usadas: `fetchOHLCV(symbol, timeframe?, since?, limit?)`, `fetchFundingRateHistory(symbol?, since?, limit?)`, `fetchOpenInterestHistory(symbol, timeframe?, since?, limit?)`.
- **pg devuelve columnas `numeric` como string** → los readers convierten con `Number(...)`.
- **DDL ya existe** (Fase 0, `src/db/schema.sql`): SP1 no crea ni altera tablas.
- Estilo: funciones <50 líneas, archivos <800, anidamiento ≤4, inmutabilidad, sin secretos hardcodeados, sin `console.log` de debug (`console.error` para reporte intencional del CLI, como `migrate.ts`).
- Comentarios y mensajes de commit en **español** (con diacríticos); identificadores en inglés. Sin atribución en commits (deshabilitada globalmente).
- **Precondición de tests de integración:** Postgres de docker arriba (`docker compose up -d postgres`) y `DATABASE_URL` en `.env` (configurado en Fase 0). Los tests de repo migran el esquema en `beforeAll`.
- **Tooling de tests ya existe (Fase 0):** `vitest.config.ts` (provider v8, umbrales 80% en las 4 métricas) y `vitest.setup.ts` (`import 'dotenv/config'`). No crear ni modificar estos archivos en SP1.

---

## Estructura de archivos

| Archivo | Responsabilidad | Task |
|---|---|---|
| `src/lib/market-data/config.ts` | Constantes (símbolos, TFs, backfill) + `timeframeToMs` + `toPerpSymbol` | 1 |
| `src/lib/market-data/types.ts` | Tipos de fila `OhlcvRow`/`FundingRow`/`OpenInterestRow` | 1 |
| `src/lib/ccxt-client.ts` | (modificar) añadir `createPerpPublicClient()` | 1 |
| `src/db/repositories/ohlcv-candles.ts` | `upsertCandles`, `getLatestOpenTime`, `getCandles` | 2 |
| `src/db/repositories/funding-rates.ts` | `upsertFundingRates`, `getLatestFundingTs`, `getFundingRange` | 3 |
| `src/db/repositories/open-interest.ts` | `upsertOpenInterest`, `getLatestOiTs`, `getOpenInterestRange` | 3 |
| `src/lib/market-data/ohlcv.ts` | `fetchClosedOHLCV` (pagina 1 request, descarta en-formación, valida) | 4 |
| `src/lib/market-data/derivatives.ts` | `fetchFundingHistory`, `fetchOpenInterestHistory` | 5 |
| `src/lib/market-data/backfill.ts` | `withRetry`, `backfillCursor`, `startFrom` + CLI `main()` | 6 |
| `package.json` | (modificar) script `backfill` | 6 |

---

### Task 1: Config, tipos compartidos y cliente perp

**Files:**
- Create: `src/lib/market-data/config.ts`
- Create: `src/lib/market-data/types.ts`
- Modify: `src/lib/ccxt-client.ts`
- Test: `src/lib/market-data/config.test.ts`, y ampliar `src/lib/ccxt-client.test.ts`

**Interfaces:**
- Consumes: `getMode` (no aquí); `ccxt`, `Exchange` de `ccxt`.
- Produces:
  - `SYMBOLS: readonly string[]`, `TIMEFRAMES: readonly ['15m','1h','4h']`, `type Timeframe`, `BACKFILL_DAYS: number`, `FETCH_LIMIT: number`, `OI_HISTORY_TIMEFRAME: string`, `OI_FETCH_LIMIT: number`
  - `timeframeToMs(timeframe: Timeframe): number`
  - `toPerpSymbol(spotSymbol: string): string`
  - `interface OhlcvRow { symbol, timeframe: string; openTime: Date; o,h,l,c,v: number }`
  - `interface FundingRow { symbol: string; ts: Date; rate: number }`
  - `interface OpenInterestRow { symbol: string; ts: Date; oi: number; oiValue: number | null }`
  - `createPerpPublicClient(): Exchange`

- [ ] **Step 1: Escribir el test de config (falla)**

```ts
// src/lib/market-data/config.test.ts
import { describe, test, expect } from 'vitest';
import { timeframeToMs, toPerpSymbol } from './config.ts';

describe('timeframeToMs', () => {
  test('mapea 15m a 900000 ms', () => {
    expect(timeframeToMs('15m')).toBe(15 * 60_000);
  });
  test('mapea 1h a 3600000 ms', () => {
    expect(timeframeToMs('1h')).toBe(60 * 60_000);
  });
  test('mapea 4h a 14400000 ms', () => {
    expect(timeframeToMs('4h')).toBe(240 * 60_000);
  });
});

describe('toPerpSymbol', () => {
  test('convierte el símbolo spot al perp USDM (cotizado en USDT)', () => {
    expect(toPerpSymbol('BTC/USDT')).toBe('BTC/USDT:USDT');
  });
});
```

- [ ] **Step 2: Correr el test para ver que falla**

Run: `npx vitest run src/lib/market-data/config.test.ts`
Expected: FAIL — `Cannot find module './config.ts'`.

- [ ] **Step 3: Implementar `config.ts` y `types.ts`**

```ts
// src/lib/market-data/config.ts
// Configuración del banco de pruebas de market-data (Fase 1 / SP1). §15, §16.3.
export const SYMBOLS = ['BTC/USDT', 'ETH/USDT'] as const;
export const TIMEFRAMES = ['15m', '1h', '4h'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

// Profundidad de backfill de OHLCV/funding (~2 años).
export const BACKFILL_DAYS = 730;

// Velas/filas por request (límite de Binance vía ccxt).
export const FETCH_LIMIT = 1000;

// Granularidad del histórico de open interest (Binance retiene poco; §6 del spec).
export const OI_HISTORY_TIMEFRAME = '5m';

// El endpoint de OI histórico de Binance limita a 500 filas/request (máx. documentado).
export const OI_FETCH_LIMIT = 500;

const MINUTE_MS = 60_000;
const TIMEFRAME_MINUTES: Record<Timeframe, number> = { '15m': 15, '1h': 60, '4h': 240 };

// Duración de un timeframe en milisegundos.
export function timeframeToMs(timeframe: Timeframe): number {
  return TIMEFRAME_MINUTES[timeframe] * MINUTE_MS;
}

// Símbolo del perp USDM equivalente al spot. Asume cotización en USDT (cierto para SYMBOLS:
// 'BTC/USDT' → 'BTC/USDT:USDT'). §15.
export function toPerpSymbol(spotSymbol: string): string {
  return `${spotSymbol}:USDT`;
}
```

```ts
// src/lib/market-data/types.ts
// Tipos de fila del histórico de market-data (camelCase TS ↔ snake_case SQL). §8.
export interface OhlcvRow {
  symbol: string;
  timeframe: string;
  openTime: Date;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface FundingRow {
  symbol: string;
  ts: Date;
  rate: number;
}

export interface OpenInterestRow {
  symbol: string;
  ts: Date;
  oi: number;
  oiValue: number | null;
}
```

- [ ] **Step 4: Correr el test para ver que pasa**

Run: `npx vitest run src/lib/market-data/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Añadir `createPerpPublicClient` y su test**

En `src/lib/ccxt-client.ts`, añadir al final (no tocar lo existente):

```ts
// Cliente PÚBLICO del mercado USDM perp (funding/OI read-only, §15). Sin API key.
export function createPerpPublicClient(): Exchange {
  return new ccxt.binanceusdm({ enableRateLimit: true });
}
```

Ampliar `src/lib/ccxt-client.test.ts` con (importar `createPerpPublicClient` en el import existente):

```ts
import { createPerpPublicClient } from './ccxt-client.ts';

describe('createPerpPublicClient', () => {
  test('crea un cliente público del perp USDM sin credenciales', () => {
    const client = createPerpPublicClient();
    expect(client.id).toBe('binanceusdm');
    expect(client.apiKey).toBeFalsy();
  });
});
```

- [ ] **Step 6: Correr typecheck + tests tocados**

Run: `npm run typecheck`
Expected: sin errores.
Run: `npx vitest run src/lib/market-data/config.test.ts src/lib/ccxt-client.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/market-data/config.ts src/lib/market-data/types.ts src/lib/ccxt-client.ts src/lib/market-data/config.test.ts src/lib/ccxt-client.test.ts
git commit -m "feat: config, tipos y cliente perp para market-data (SP1)"
```

---

### Task 2: Repositorio de OHLCV

**Files:**
- Create: `src/db/repositories/ohlcv-candles.ts`
- Test: `src/db/repositories/ohlcv-candles.test.ts`

**Interfaces:**
- Consumes: `query`, `QueryParam` de `src/db/pool.ts`; `OhlcvRow` de `src/lib/market-data/types.ts`; `migrate` de `src/db/migrate.ts` (solo en el test); `pool` (solo teardown del test).
- Produces:
  - `upsertCandles(rows: OhlcvRow[]): Promise<number>` — nº filas realmente insertadas (idempotente por PK)
  - `getLatestOpenTime(symbol: string, timeframe: string): Promise<Date | null>`
  - `getCandles(symbol: string, timeframe: string, from: Date, to: Date): Promise<OhlcvRow[]>` — ascendente por `openTime`

- [ ] **Step 1: Escribir el test de integración (falla)**

```ts
// src/db/repositories/ohlcv-candles.test.ts
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { upsertCandles, getLatestOpenTime, getCandles } from './ohlcv-candles.ts';
import type { OhlcvRow } from '../../lib/market-data/types.ts';

const SYMBOL = 'TEST/USDT';

function candle(iso: string, c: number): OhlcvRow {
  return { symbol: SYMBOL, timeframe: '15m', openTime: new Date(iso), o: c, h: c, l: c, c, v: 1 };
}

beforeAll(async () => {
  await migrate();
});

beforeEach(async () => {
  await query('DELETE FROM kairos.ohlcv_candles WHERE symbol = $1', [SYMBOL]);
});

afterAll(async () => {
  await query('DELETE FROM kairos.ohlcv_candles WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('upsertCandles', () => {
  test('inserta velas nuevas y devuelve el conteo', async () => {
    const inserted = await upsertCandles([
      candle('2026-01-01T00:00:00Z', 100),
      candle('2026-01-01T00:15:00Z', 101),
    ]);
    expect(inserted).toBe(2);
  });

  test('es idempotente: re-insertar el mismo lote inserta 0 (PK)', async () => {
    const batch = [candle('2026-01-01T00:00:00Z', 100)];
    await upsertCandles(batch);
    expect(await upsertCandles(batch)).toBe(0);
  });

  test('lote vacío inserta 0', async () => {
    expect(await upsertCandles([])).toBe(0);
  });

  test('chunking: inserta >500 filas en múltiples chunks y suma el total', async () => {
    const base = Date.parse('2026-02-01T00:00:00Z');
    const rows = Array.from({ length: 501 }, (_, i) =>
      candle(new Date(base + i * 15 * 60_000).toISOString(), 100 + i),
    );
    expect(await upsertCandles(rows)).toBe(501); // 500 + 1 → 2 chunks
    expect(await upsertCandles(rows)).toBe(0);    // idempotente tras chunking
  });
});

describe('getLatestOpenTime', () => {
  test('devuelve null cuando no hay velas', async () => {
    expect(await getLatestOpenTime(SYMBOL, '15m')).toBeNull();
  });

  test('devuelve el open_time máximo', async () => {
    await upsertCandles([candle('2026-01-01T00:00:00Z', 100), candle('2026-01-01T00:15:00Z', 101)]);
    const latest = await getLatestOpenTime(SYMBOL, '15m');
    expect(latest?.toISOString()).toBe('2026-01-01T00:15:00.000Z');
  });
});

describe('getCandles', () => {
  test('devuelve el rango ascendente y excluye fuera de [from,to]', async () => {
    await upsertCandles([
      candle('2026-01-01T00:00:00Z', 100),
      candle('2026-01-01T00:15:00Z', 101),
      candle('2026-01-01T00:30:00Z', 102),
    ]);
    const rows = await getCandles(
      SYMBOL, '15m',
      new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:15:00Z'),
    );
    expect(rows.map((r) => r.c)).toEqual([100, 101]);
    expect(rows[0].openTime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Correr el test para ver que falla**

Run: `npx vitest run src/db/repositories/ohlcv-candles.test.ts`
Expected: FAIL — `Cannot find module './ohlcv-candles.ts'`.

- [ ] **Step 3: Implementar el repo**

```ts
// src/db/repositories/ohlcv-candles.ts
import { query, type QueryParam } from '../pool.ts';
import type { OhlcvRow } from '../../lib/market-data/types.ts';

const COLS_PER_ROW = 8;
const CHUNK_ROWS = 500; // 500 × 8 = 4000 params, holgado bajo el límite de pg (65535)

// Upsert idempotente por PK (symbol, timeframe, open_time): re-ingestar no duplica (§15.3).
export async function upsertCandles(rows: OhlcvRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    inserted += await upsertChunk(rows.slice(i, i + CHUNK_ROWS));
  }
  return inserted;
}

async function upsertChunk(rows: OhlcvRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: QueryParam[] = [];
  rows.forEach((row, i) => {
    const b = i * COLS_PER_ROW;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
    params.push(row.symbol, row.timeframe, row.openTime, row.o, row.h, row.l, row.c, row.v);
  });
  // RETURNING 1: con DO NOTHING solo vuelven las filas realmente insertadas → length = conteo.
  const result = await query(
    `INSERT INTO kairos.ohlcv_candles (symbol, timeframe, open_time, o, h, l, c, v)
     VALUES ${values.join(', ')}
     ON CONFLICT (symbol, timeframe, open_time) DO NOTHING
     RETURNING 1`,
    params,
  );
  return result.length;
}

export async function getLatestOpenTime(symbol: string, timeframe: string): Promise<Date | null> {
  const rows = await query<{ open_time: Date | null }>(
    `SELECT max(open_time) AS open_time
       FROM kairos.ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2`,
    [symbol, timeframe],
  );
  return rows[0]?.open_time ?? null;
}

export async function getCandles(
  symbol: string, timeframe: string, from: Date, to: Date,
): Promise<OhlcvRow[]> {
  const rows = await query<{
    symbol: string; timeframe: string; open_time: Date;
    o: string; h: string; l: string; c: string; v: string;
  }>(
    `SELECT symbol, timeframe, open_time, o, h, l, c, v
       FROM kairos.ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2 AND open_time >= $3 AND open_time <= $4
      ORDER BY open_time ASC`,
    [symbol, timeframe, from, to],
  );
  // pg devuelve numeric como string → convertir a number.
  return rows.map((r) => ({
    symbol: r.symbol, timeframe: r.timeframe, openTime: r.open_time,
    o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v),
  }));
}
```

- [ ] **Step 4: Correr el test para ver que pasa**

Run: `npx vitest run src/db/repositories/ohlcv-candles.test.ts`
Expected: PASS (todos). (Requiere Postgres de docker arriba.)

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: sin errores.

```bash
git add src/db/repositories/ohlcv-candles.ts src/db/repositories/ohlcv-candles.test.ts
git commit -m "feat: repositorio de velas OHLCV con upsert idempotente (SP1)"
```

---

### Task 3: Repositorios de derivados (funding + open interest)

**Files:**
- Create: `src/db/repositories/funding-rates.ts`
- Create: `src/db/repositories/open-interest.ts`
- Test: `src/db/repositories/funding-rates.test.ts`, `src/db/repositories/open-interest.test.ts`

**Interfaces:**
- Consumes: `query`, `QueryParam` de `src/db/pool.ts`; `FundingRow`, `OpenInterestRow` de `src/lib/market-data/types.ts`; `migrate`/`pool` (tests).
- Produces:
  - `upsertFundingRates(rows: FundingRow[]): Promise<number>`, `getLatestFundingTs(symbol: string): Promise<Date | null>`, `getFundingRange(symbol: string, from: Date, to: Date): Promise<FundingRow[]>`
  - `upsertOpenInterest(rows: OpenInterestRow[]): Promise<number>`, `getLatestOiTs(symbol: string): Promise<Date | null>`, `getOpenInterestRange(symbol: string, from: Date, to: Date): Promise<OpenInterestRow[]>`

- [ ] **Step 1: Escribir los tests de integración (fallan)**

```ts
// src/db/repositories/funding-rates.test.ts
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { upsertFundingRates, getLatestFundingTs, getFundingRange } from './funding-rates.ts';
import type { FundingRow } from '../../lib/market-data/types.ts';

const SYMBOL = 'TEST/USDT';
const row = (iso: string, rate: number): FundingRow => ({ symbol: SYMBOL, ts: new Date(iso), rate });

beforeAll(async () => { await migrate(); });
beforeEach(async () => { await query('DELETE FROM kairos.funding_rates WHERE symbol = $1', [SYMBOL]); });
afterAll(async () => {
  await query('DELETE FROM kairos.funding_rates WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('funding-rates repo', () => {
  test('upsert inserta y es idempotente por PK (symbol, ts)', async () => {
    const batch = [row('2026-01-01T00:00:00Z', 0.0001), row('2026-01-01T08:00:00Z', 0.0002)];
    expect(await upsertFundingRates(batch)).toBe(2);
    expect(await upsertFundingRates(batch)).toBe(0);
  });

  test('getLatestFundingTs devuelve null sin datos y luego el máximo', async () => {
    expect(await getLatestFundingTs(SYMBOL)).toBeNull();
    await upsertFundingRates([row('2026-01-01T00:00:00Z', 0.0001), row('2026-01-01T08:00:00Z', 0.0002)]);
    expect((await getLatestFundingTs(SYMBOL))?.toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });

  test('getFundingRange devuelve el rango ascendente convertido a number', async () => {
    await upsertFundingRates([row('2026-01-01T00:00:00Z', 0.0001), row('2026-01-01T08:00:00Z', 0.0002)]);
    const rows = await getFundingRange(SYMBOL, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T08:00:00Z'));
    expect(rows.map((r) => r.rate)).toEqual([0.0001, 0.0002]);
  });
});
```

```ts
// src/db/repositories/open-interest.test.ts
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { upsertOpenInterest, getLatestOiTs, getOpenInterestRange } from './open-interest.ts';
import type { OpenInterestRow } from '../../lib/market-data/types.ts';

const SYMBOL = 'TEST/USDT';
const row = (iso: string, oi: number, oiValue: number | null): OpenInterestRow =>
  ({ symbol: SYMBOL, ts: new Date(iso), oi, oiValue });

beforeAll(async () => { await migrate(); });
beforeEach(async () => { await query('DELETE FROM kairos.open_interest WHERE symbol = $1', [SYMBOL]); });
afterAll(async () => {
  await query('DELETE FROM kairos.open_interest WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('open-interest repo', () => {
  test('upsert inserta y es idempotente por PK (symbol, ts)', async () => {
    const batch = [row('2026-01-01T00:00:00Z', 500, 1_000_000), row('2026-01-01T00:05:00Z', 510, null)];
    expect(await upsertOpenInterest(batch)).toBe(2);
    expect(await upsertOpenInterest(batch)).toBe(0);
  });

  test('persiste oiValue null y lo devuelve', async () => {
    await upsertOpenInterest([row('2026-01-01T00:00:00Z', 500, null)]);
    const rows = await getOpenInterestRange(SYMBOL, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:05:00Z'));
    expect(rows[0].oi).toBe(500);
    expect(rows[0].oiValue).toBeNull();
  });

  test('getLatestOiTs devuelve el máximo', async () => {
    await upsertOpenInterest([row('2026-01-01T00:00:00Z', 500, 1), row('2026-01-01T00:05:00Z', 510, 2)]);
    expect((await getLatestOiTs(SYMBOL))?.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });
});
```

- [ ] **Step 2: Correr los tests para ver que fallan**

Run: `npx vitest run src/db/repositories/funding-rates.test.ts src/db/repositories/open-interest.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar los repos**

```ts
// src/db/repositories/funding-rates.ts
import { query, type QueryParam } from '../pool.ts';
import type { FundingRow } from '../../lib/market-data/types.ts';

const COLS_PER_ROW = 3;
const CHUNK_ROWS = 1000; // 1000 × 3 = 3000 params

// Upsert idempotente por PK (symbol, ts). Funding del perp como señal read-only (§15).
export async function upsertFundingRates(rows: FundingRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    inserted += await upsertChunk(rows.slice(i, i + CHUNK_ROWS));
  }
  return inserted;
}

async function upsertChunk(rows: FundingRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: QueryParam[] = [];
  rows.forEach((row, i) => {
    const b = i * COLS_PER_ROW;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
    params.push(row.symbol, row.ts, row.rate);
  });
  const result = await query(
    `INSERT INTO kairos.funding_rates (symbol, ts, rate)
     VALUES ${values.join(', ')}
     ON CONFLICT (symbol, ts) DO NOTHING
     RETURNING 1`,
    params,
  );
  return result.length;
}

export async function getLatestFundingTs(symbol: string): Promise<Date | null> {
  const rows = await query<{ ts: Date | null }>(
    `SELECT max(ts) AS ts FROM kairos.funding_rates WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]?.ts ?? null;
}

export async function getFundingRange(symbol: string, from: Date, to: Date): Promise<FundingRow[]> {
  const rows = await query<{ symbol: string; ts: Date; rate: string }>(
    `SELECT symbol, ts, rate FROM kairos.funding_rates
      WHERE symbol = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts ASC`,
    [symbol, from, to],
  );
  return rows.map((r) => ({ symbol: r.symbol, ts: r.ts, rate: Number(r.rate) }));
}
```

```ts
// src/db/repositories/open-interest.ts
import { query, type QueryParam } from '../pool.ts';
import type { OpenInterestRow } from '../../lib/market-data/types.ts';

const COLS_PER_ROW = 4;
const CHUNK_ROWS = 1000; // 1000 × 4 = 4000 params

// Upsert idempotente por PK (symbol, ts). OI del perp como señal read-only (§15).
export async function upsertOpenInterest(rows: OpenInterestRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    inserted += await upsertChunk(rows.slice(i, i + CHUNK_ROWS));
  }
  return inserted;
}

async function upsertChunk(rows: OpenInterestRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: QueryParam[] = [];
  rows.forEach((row, i) => {
    const b = i * COLS_PER_ROW;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
    params.push(row.symbol, row.ts, row.oi, row.oiValue);
  });
  const result = await query(
    `INSERT INTO kairos.open_interest (symbol, ts, oi, oi_value)
     VALUES ${values.join(', ')}
     ON CONFLICT (symbol, ts) DO NOTHING
     RETURNING 1`,
    params,
  );
  return result.length;
}

export async function getLatestOiTs(symbol: string): Promise<Date | null> {
  const rows = await query<{ ts: Date | null }>(
    `SELECT max(ts) AS ts FROM kairos.open_interest WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]?.ts ?? null;
}

export async function getOpenInterestRange(symbol: string, from: Date, to: Date): Promise<OpenInterestRow[]> {
  const rows = await query<{ symbol: string; ts: Date; oi: string; oi_value: string | null }>(
    `SELECT symbol, ts, oi, oi_value FROM kairos.open_interest
      WHERE symbol = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts ASC`,
    [symbol, from, to],
  );
  return rows.map((r) => ({
    symbol: r.symbol, ts: r.ts, oi: Number(r.oi),
    oiValue: r.oi_value === null ? null : Number(r.oi_value),
  }));
}
```

- [ ] **Step 4: Correr los tests para ver que pasan**

Run: `npx vitest run src/db/repositories/funding-rates.test.ts src/db/repositories/open-interest.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: sin errores.

```bash
git add src/db/repositories/funding-rates.ts src/db/repositories/open-interest.ts src/db/repositories/funding-rates.test.ts src/db/repositories/open-interest.test.ts
git commit -m "feat: repositorios de funding y open interest (SP1)"
```

---

### Task 4: Fetch de OHLCV (ccxt → filas, solo velas cerradas)

**Files:**
- Create: `src/lib/market-data/ohlcv.ts`
- Test: `src/lib/market-data/ohlcv.test.ts`

**Interfaces:**
- Consumes: `Exchange` de `ccxt`; `timeframeToMs`, `Timeframe` de `./config.ts`; `OhlcvRow` de `./types.ts`.
- Produces: `fetchClosedOHLCV(client: Exchange, symbol: string, timeframe: Timeframe, since: number, limit?: number, now?: number): Promise<OhlcvRow[]>` — solo velas cerradas, ascendente; lanza si la forma de ccxt está rota.

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/market-data/ohlcv.test.ts
import { describe, test, expect } from 'vitest';
import type { Exchange } from 'ccxt';
import { fetchClosedOHLCV } from './ohlcv.ts';

const TF = '15m';
const TF_MS = 15 * 60_000;

function fakeClient(raw: unknown): Exchange {
  return { fetchOHLCV: async () => raw } as unknown as Exchange;
}

describe('fetchClosedOHLCV', () => {
  test('descarta la vela en formación (la última aún abierta)', async () => {
    const raw = [
      [0, 10, 11, 9, 10, 100],
      [TF_MS, 10, 12, 10, 11, 120],
      [2 * TF_MS, 11, 13, 11, 12, 130], // en formación respecto a `now`
    ];
    const now = 2 * TF_MS + 1;
    const rows = await fetchClosedOHLCV(fakeClient(raw), 'BTC/USDT', TF, 0, 1000, now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      symbol: 'BTC/USDT', timeframe: TF, openTime: new Date(0),
      o: 10, h: 11, l: 9, c: 10, v: 100,
    });
    expect(rows[1].openTime).toEqual(new Date(TF_MS));
  });

  test('mapea o/h/l/c/v correctamente', async () => {
    const raw = [[0, 1, 2, 0.5, 1.5, 999]];
    const rows = await fetchClosedOHLCV(fakeClient(raw), 'ETH/USDT', TF, 0, 1000, TF_MS + 1);
    expect(rows[0]).toMatchObject({ o: 1, h: 2, l: 0.5, c: 1.5, v: 999 });
  });

  test('lanza si la respuesta de ccxt está malformada (contrato roto)', async () => {
    const raw = [[0, 10, 11, 9]]; // tupla demasiado corta
    await expect(
      fetchClosedOHLCV(fakeClient(raw), 'BTC/USDT', TF, 0, 1000, TF_MS + 1),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr el test para ver que falla**

Run: `npx vitest run src/lib/market-data/ohlcv.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `ohlcv.ts`**

```ts
// src/lib/market-data/ohlcv.ts
import * as v from 'valibot';
import type { Exchange } from 'ccxt';
import { timeframeToMs, type Timeframe } from './config.ts';
import type { OhlcvRow } from './types.ts';

// ccxt OHLCV: [timestamp, open, high, low, close, volume]; cada campo Num = number | undefined.
// Exigimos ≥6 numbers reales: un campo undefined o no-numérico = contrato ccxt roto → v.parse lanza.
const OhlcvArraySchema = v.pipe(v.array(v.number()), v.minLength(6));

// Una vela está cerrada si su cierre (open + duración del TF) ya pasó respecto a `now` (§15.3).
function isClosed(openTimeMs: number, timeframe: Timeframe, now: number): boolean {
  return openTimeMs + timeframeToMs(timeframe) <= now;
}

// Trae velas y devuelve SOLO las cerradas, ascendentes. Valida la forma cruda de ccxt:
// una forma rota = contrato ccxt desalineado → lanza (no se descarta en silencio).
export async function fetchClosedOHLCV(
  client: Exchange,
  symbol: string,
  timeframe: Timeframe,
  since: number,
  limit = 1000,
  now: number = Date.now(),
): Promise<OhlcvRow[]> {
  const raw = await client.fetchOHLCV(symbol, timeframe, since, limit);
  return raw
    .map((candle) => v.parse(OhlcvArraySchema, candle))
    .filter((c) => isClosed(c[0], timeframe, now))
    .map((c) => ({
      symbol, timeframe, openTime: new Date(c[0]),
      o: c[1], h: c[2], l: c[3], c: c[4], v: c[5],
    }));
}
```

- [ ] **Step 4: Correr el test para ver que pasa**

Run: `npx vitest run src/lib/market-data/ohlcv.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: sin errores.

```bash
git add src/lib/market-data/ohlcv.ts src/lib/market-data/ohlcv.test.ts
git commit -m "feat: fetch de OHLCV con descarte de vela en formación y validación (SP1)"
```

---

### Task 5: Fetch de derivados (funding + open interest)

**Files:**
- Create: `src/lib/market-data/derivatives.ts`
- Test: `src/lib/market-data/derivatives.test.ts`

**Interfaces:**
- Consumes: `Exchange` de `ccxt`; `toPerpSymbol` de `./config.ts`; `FundingRow`, `OpenInterestRow` de `./types.ts`.
- Produces:
  - `fetchFundingHistory(client: Exchange, symbol: string, since: number, limit?: number): Promise<FundingRow[]>`
  - `fetchOpenInterestHistory(client: Exchange, symbol: string, timeframe: string, since: number, limit?: number): Promise<OpenInterestRow[]>`
  - Ambas reciben el **símbolo spot** y persisten el símbolo spot; usan `toPerpSymbol` solo para la llamada ccxt.

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/market-data/derivatives.test.ts
import { describe, test, expect } from 'vitest';
import type { Exchange } from 'ccxt';
import { fetchFundingHistory, fetchOpenInterestHistory } from './derivatives.ts';

const fakeFunding = (raw: unknown): Exchange =>
  ({ fetchFundingRateHistory: async () => raw }) as unknown as Exchange;
const fakeOi = (raw: unknown): Exchange =>
  ({ fetchOpenInterestHistory: async () => raw }) as unknown as Exchange;

describe('fetchFundingHistory', () => {
  test('mapea fundingRate/timestamp y conserva el símbolo spot', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', fundingRate: 0.0001, timestamp: 1000, info: {} }];
    const rows = await fetchFundingHistory(fakeFunding(raw), 'BTC/USDT', 0, 1000);
    expect(rows).toEqual([{ symbol: 'BTC/USDT', ts: new Date(1000), rate: 0.0001 }]);
  });

  test('lanza si falta fundingRate (contrato roto)', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', timestamp: 1000, info: {} }];
    await expect(fetchFundingHistory(fakeFunding(raw), 'BTC/USDT', 0)).rejects.toThrow();
  });
});

describe('fetchOpenInterestHistory', () => {
  test('mapea oi y oiValue', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', openInterestAmount: 500, openInterestValue: 1_000_000, timestamp: 2000, info: {} }];
    const rows = await fetchOpenInterestHistory(fakeOi(raw), 'BTC/USDT', '5m', 0, 500);
    expect(rows).toEqual([{ symbol: 'BTC/USDT', ts: new Date(2000), oi: 500, oiValue: 1_000_000 }]);
  });

  test('oiValue es null cuando falta', async () => {
    const raw = [{ symbol: 'BTC/USDT:USDT', openInterestAmount: 500, timestamp: 2000, info: {} }];
    const rows = await fetchOpenInterestHistory(fakeOi(raw), 'BTC/USDT', '5m', 0);
    expect(rows[0].oiValue).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test para ver que falla**

Run: `npx vitest run src/lib/market-data/derivatives.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `derivatives.ts`**

```ts
// src/lib/market-data/derivatives.ts
import * as v from 'valibot';
import type { Exchange } from 'ccxt';
import { toPerpSymbol } from './config.ts';
import type { FundingRow, OpenInterestRow } from './types.ts';

const FundingSchema = v.object({
  fundingRate: v.number(),
  timestamp: v.number(),
});

const OpenInterestSchema = v.object({
  openInterestAmount: v.number(),
  openInterestValue: v.nullish(v.number()),
  timestamp: v.number(),
});

// Funding histórico del perp USDM. Recibe el símbolo spot; persiste el símbolo spot.
// `client` DEBE ser un cliente perp (ccxt.binanceusdm); un cliente Spot consultaría otro mercado.
export async function fetchFundingHistory(
  client: Exchange, symbol: string, since: number, limit = 1000,
): Promise<FundingRow[]> {
  const raw = await client.fetchFundingRateHistory(toPerpSymbol(symbol), since, limit);
  return raw.map((item) => {
    const parsed = v.parse(FundingSchema, item);
    return { symbol, ts: new Date(parsed.timestamp), rate: parsed.fundingRate };
  });
}

// Open interest histórico del perp USDM. oiValue puede faltar → null.
// `client` DEBE ser un cliente perp (ccxt.binanceusdm), igual que fetchFundingHistory.
export async function fetchOpenInterestHistory(
  client: Exchange, symbol: string, timeframe: string, since: number, limit = 500,
): Promise<OpenInterestRow[]> {
  const raw = await client.fetchOpenInterestHistory(toPerpSymbol(symbol), timeframe, since, limit);
  return raw.map((item) => {
    const parsed = v.parse(OpenInterestSchema, item);
    return {
      symbol, ts: new Date(parsed.timestamp),
      oi: parsed.openInterestAmount, oiValue: parsed.openInterestValue ?? null,
    };
  });
}
```

- [ ] **Step 4: Correr el test para ver que pasa**

Run: `npx vitest run src/lib/market-data/derivatives.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: sin errores.

```bash
git add src/lib/market-data/derivatives.ts src/lib/market-data/derivatives.test.ts
git commit -m "feat: fetch de funding y open interest del perp con validación (SP1)"
```

---

### Task 6: Backfill resumible + CLI

**Files:**
- Create: `src/lib/market-data/backfill.ts`
- Modify: `package.json` (script `backfill`)
- Test: `src/lib/market-data/backfill.test.ts`

**Interfaces:**
- Consumes: `ccxt` (para `ccxt.NetworkError`); `createPublicClient`, `createPerpPublicClient` de `../ccxt-client.ts`; constantes y helpers de `./config.ts`; `fetchClosedOHLCV` de `./ohlcv.ts`; `fetchFundingHistory`/`fetchOpenInterestHistory` de `./derivatives.ts`; tipos de `./types.ts`. Los repos y `pool` se importan **dinámicamente dentro de `main()`** (orden env-antes-de-pool).
- Produces (exportados, testables sin DB/red):
  - `type Sleep = (ms: number) => Promise<void>`
  - `withRetry<T>(fn: () => Promise<T>, sleep: Sleep): Promise<T>` — reintenta solo `ccxt.NetworkError`
  - `interface CursorSource<Row> { fetchPage(since): Promise<Row[]>; upsert(rows): Promise<number>; cursorOf(row): number; step: number }`
  - `backfillCursor<Row>(src: CursorSource<Row>, startSince: number, now: number, sleep: Sleep): Promise<number>`
  - `startFrom(latest: Date | null, step: number, now: number): number`

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/market-data/backfill.test.ts
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
```

- [ ] **Step 2: Correr el test para ver que falla**

Run: `npx vitest run src/lib/market-data/backfill.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `backfill.ts`**

> **Orden env-antes-de-pool (verificado).** `pool.ts` lanza si falta `DATABASE_URL` al importarse, así que ningún import estático de `backfill.ts` debe arrastrarlo. Verificado: `config`/`ohlcv`/`derivatives`/`types` no importan `pool`; `ccxt-client.ts` → `mode.ts` tampoco (y `getMode()` lee env solo al llamarse, no al importar); los clientes ccxt se construyen DENTRO de `main()`, tras `dotenv`. Los repos y `pool` se importan **dinámicamente dentro de `main()`** —mismo patrón que `migrate.ts`. Si en el futuro `mode.ts`/`ccxt-client.ts` llegaran a importar `pool`, mover su uso a importación dinámica dentro de `main()`.

```ts
// src/lib/market-data/backfill.ts
import ccxt from 'ccxt';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createPerpPublicClient } from '../ccxt-client.ts';
import {
  SYMBOLS, TIMEFRAMES, BACKFILL_DAYS, FETCH_LIMIT, OI_HISTORY_TIMEFRAME, OI_FETCH_LIMIT, timeframeToMs,
} from './config.ts';
import { fetchClosedOHLCV } from './ohlcv.ts';
import { fetchFundingHistory, fetchOpenInterestHistory } from './derivatives.ts';
import type { OhlcvRow, FundingRow, OpenInterestRow } from './types.ts';

const DAY_MS = 86_400_000;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 1000;

export type Sleep = (ms: number) => Promise<void>;

// Reintenta SOLO errores de red de ccxt (recuperables). Validación/otros fallan fuerte.
export async function withRetry<T>(fn: () => Promise<T>, sleep: Sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ccxt.NetworkError && attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
}

export interface CursorSource<Row> {
  fetchPage: (since: number) => Promise<Row[]>;
  upsert: (rows: Row[]) => Promise<number>;
  cursorOf: (row: Row) => number; // timestamp ms de la fila
  step: number;                   // ms a avanzar tras el último cursor
}

// Bucle de backfill resumible por cursor temporal. Genérico para OHLCV/funding/OI (DRY).
// Asume páginas ASCENDENTES por ts (contrato de Binance en fetchOHLCV/fetchFundingRateHistory/
// fetchOpenInterestHistory): usa la última fila como cursor. `step` = ms a saltar tras el último
// cursor (tfMs para OHLCV; 1 ms para funding/OI, registros discretos).
export async function backfillCursor<Row>(
  src: CursorSource<Row>, startSince: number, now: number, sleep: Sleep,
): Promise<number> {
  let since = startSince;
  let total = 0;
  while (since < now) {
    const rows = await withRetry(() => src.fetchPage(since), sleep);
    if (rows.length === 0) break;
    total += await src.upsert(rows);
    const next = src.cursorOf(rows[rows.length - 1]) + src.step;
    if (next <= since) break; // sin avance → corta para no ciclar
    since = next;
  }
  return total;
}

// startSince: desde el último guardado (+step) o BACKFILL_DAYS atrás en arranque en frío.
export function startFrom(latest: Date | null, step: number, now: number): number {
  return latest ? latest.getTime() + step : now - BACKFILL_DAYS * DAY_MS;
}

// v8 ignore start — orquestación CLI: requiere exchange real + Postgres; se valida con
// `npm run backfill` (ver nota final del plan), no en unit tests.
async function main(): Promise<void> {
  const { upsertCandles, getLatestOpenTime } = await import('../../db/repositories/ohlcv-candles.ts');
  const { upsertFundingRates, getLatestFundingTs } = await import('../../db/repositories/funding-rates.ts');
  const { upsertOpenInterest, getLatestOiTs } = await import('../../db/repositories/open-interest.ts');
  const { pool } = await import('../../db/pool.ts');

  const spot = createPublicClient();
  const perp = createPerpPublicClient();
  const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = Date.now();

  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const tfMs = timeframeToMs(timeframe);
      const latest = await getLatestOpenTime(symbol, timeframe);
      const n = await backfillCursor<OhlcvRow>(
        {
          fetchPage: (since) => fetchClosedOHLCV(spot, symbol, timeframe, since, FETCH_LIMIT, now),
          upsert: upsertCandles,
          cursorOf: (r) => r.openTime.getTime(),
          step: tfMs,
        },
        startFrom(latest, tfMs, now), now, sleep,
      );
      console.error(`OHLCV ${symbol} ${timeframe}: +${n}`);
    }

    const fLatest = await getLatestFundingTs(symbol);
    const f = await backfillCursor<FundingRow>(
      {
        fetchPage: (since) => fetchFundingHistory(perp, symbol, since, FETCH_LIMIT),
        upsert: upsertFundingRates,
        cursorOf: (r) => r.ts.getTime(),
        step: 1,
      },
      startFrom(fLatest, 1, now), now, sleep,
    );
    console.error(`funding ${symbol}: +${f}`);

    const oLatest = await getLatestOiTs(symbol);
    const o = await backfillCursor<OpenInterestRow>(
      {
        fetchPage: (since) => fetchOpenInterestHistory(perp, symbol, OI_HISTORY_TIMEFRAME, since, OI_FETCH_LIMIT),
        upsert: upsertOpenInterest,
        cursorOf: (r) => r.ts.getTime(),
        step: 1,
      },
      startFrom(oLatest, 1, now), now, sleep,
    );
    console.error(`OI ${symbol}: +${o}`);
  }

  await pool.end();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await import('dotenv/config');
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Backfill falló:', error);
      process.exit(1);
    });
}
// v8 ignore stop
```

- [ ] **Step 4: Correr el test para ver que pasa**

Run: `npx vitest run src/lib/market-data/backfill.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Añadir el script `backfill` a `package.json`**

En `package.json`, dentro de `"scripts"`, añadir tras la línea de `migrate`:

```json
    "backfill": "node --experimental-strip-types src/lib/market-data/backfill.ts",
```

- [ ] **Step 6: Typecheck + suite completa + cobertura**

Run: `npm run typecheck`
Expected: sin errores.
Run: `npx vitest run --coverage`
Expected: PASS; cobertura global ≥80% en las cuatro métricas.

- [ ] **Step 7: Commit**

```bash
git add src/lib/market-data/backfill.ts src/lib/market-data/backfill.test.ts package.json
git commit -m "feat: comando de backfill resumible de market-data (SP1)"
```

---

## Verificación final (manual, una vez)

Tras las 6 tasks, validar el backfill real contra Binance (no en CI). Esta es la prueba del criterio de éxito §11 del spec:

```bash
docker compose up -d postgres
npm run migrate        # idempotente; las tablas ya existen
npm run backfill       # puebla ~2 años de OHLCV + funding + OI (puede tardar varios minutos)
npm run backfill       # segunda corrida: debe insertar ~0 (idempotente, reanuda)
```

Comprobar en Postgres que `kairos.ohlcv_candles` tiene velas para BTC/USDT y ETH/USDT en 15m/1h/4h, que no hay vela en formación (la última `open_time + duración ≤ now`), y que la segunda corrida no duplicó.

---

## Self-Review del plan

**Cobertura del spec:**
- §1 ingesta REST idempotente → Tasks 2–6. §2 universo/TFs/historia → Task 1 (config). §3 modelo de datos (sin DDL) → Tasks 2–3 usan tablas existentes. §4 componentes/archivos → mapeo 1:1 en "Estructura de archivos". §4.1 interfaces → bloques Interfaces de cada task. §5 flujo/backfill resumible → Task 6. §6 retención OI → `OI_HISTORY_TIMEFRAME` + backfill tolerante (corta en página vacía). §7 verificación ccxt → hecha en el plan (firmas/retornos confirmados). §8 errores (retry red, falla fuerte en malformado, idempotencia) → `withRetry` + `v.parse` + `ON CONFLICT`. §9 pruebas → tests unit (mock) + integración (Postgres). §10 líneas rojas → Global Constraints. §11 criterios de éxito → Verificación final + cobertura.
- Diferidos correctamente fuera de SP1: scheduler/cron, WS, liquidaciones, caché Redis, read tools `defineTool`, cómputo de features.

**Placeholder scan:** sin TBD/TODO; todo step de código trae el código completo; comandos con salida esperada.

**Consistencia de tipos:** `OhlcvRow`/`FundingRow`/`OpenInterestRow` definidos en Task 1 y consumidos verbatim por Tasks 2–6. Firmas de repos (Task 2/3) coinciden con las que `backfillCursor` espera vía `CursorSource` (Task 6). `fetchClosedOHLCV`/`fetchFundingHistory`/`fetchOpenInterestHistory` (Task 4/5) coinciden con su uso en `main()` (Task 6). `toPerpSymbol`/`timeframeToMs` (Task 1) usados en Task 5/6.
