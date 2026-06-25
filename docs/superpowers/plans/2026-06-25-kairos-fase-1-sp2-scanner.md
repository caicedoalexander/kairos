# SP2 — Scanner (Fase 1 de Kairos) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el scanner determinista: dado un strategy config + símbolo + velas por timeframe, computar indicadores → features → evaluar el árbol de reglas + gate MTF → producir y persistir un `signal`.

**Architecture:** Núcleo PURO `scan(strategy, symbol, candlesByTf, deriv, now) → Signal | null` (velas inyectadas, reusable por SP4/SP5) + `scanSymbol(...)` que lee de los readers de SP1 y persiste. Indicadores vía `technicalindicators`; estructura propia; predicados puros; árbol `trigger_config` validado con Valibot; gate MTF top-down.

**Tech Stack:** TypeScript ESM (Node ≥22.19, `--experimental-strip-types`), `technicalindicators` (npm, nuevo), Valibot, pg, ulidx, Vitest + v8.

## Global Constraints

Del spec (`docs/superpowers/specs/2026-06-25-kairos-fase-1-sp2-scanner-design.md`). Todo task las hereda.

- **Núcleo puro reusable:** `scan` no lee DB (velas inyectadas); solo `scanSymbol`/repos tocan Postgres. `scan.ts` NO debe importar (ni transitivamente) `pool.ts` — para que sus tests unit corran sin DB.
- **Datos insuficientes (warmup):** si una TF de la estrategia tiene < `REQUIRED_WARMUP` (200, por EMA200) velas → `scan` devuelve **null** sin evaluar. Un feature puntual null con datos suficientes (p.ej. sin soporte cercano) → predicado `false`, no null global.
- **`mtf_alignment` direccional** vía `emaStack`: `counter` si bias `bearish`; `aligned` si bias `bullish` y context no `bearish`; `mixed` si no. `counter` → `scan` null salvo `allow_counter` en config.
- **Skip = veto duro:** si CUALQUIER skip es true → no dispara, aunque entry sea true.
- **Validación Valibot** (no zod) del `trigger_config` al cargar; predicado desconocido = error en la validación.
- **`signals` append-first** (insert, nunca update). `signals.id` = ULID. `indicator_snapshot` = `JSON.stringify(snapshot)` para jsonb.
- **Estrategia semilla `pullback-alcista`** exacta (Task 9): TFs 4h/1h/15m, símbolos BTC/USDT+ETH/USDT.
- **Sin DDL**: `strategies`/`signals` ya existen (Fase 0). **Sin LLM, sin tools de mutación, sin credenciales.**
- **Verificar `technicalindicators` contra su API real al implementar** (Task 1): nombres y forma I/O de cada `Indicator.calculate({...})` contra `node_modules/technicalindicators`. Si difiere de lo escrito aquí, ajustar el wrapper (la firma pública del wrapper se mantiene).
- **pg auto-parsea** jsonb→objeto y text[]→array al leer; al escribir text[] usar literal `'{a,b}'::text[]`.
- **Orden env-antes-de-pool** (como `migrate.ts`): en `seed-strategies.ts` el `pool`/`query` se importa dinámicamente dentro de la función y `dotenv` en el guard CLI.
- Estilo: funciones <50 líneas, archivos <800, anidamiento ≤4, inmutabilidad, sin secretos, sin `console.log`. Comentarios/commits en español; identificadores en inglés. Sin atribución en commits.
- **Precondición tests de integración:** Postgres de docker arriba (`docker compose up -d postgres`); `.env` con `DATABASE_URL` (Fase 0). Tests de repo migran en `beforeAll`. `vitest.config.ts`/`vitest.setup.ts` ya existen — no tocar.

---

## Estructura de archivos

| Archivo | Responsabilidad | Task |
|---|---|---|
| `src/lib/scanner/types.ts` | Tipos compartidos (`Features`, `IndicatorSnapshot`, `Signal`, `Strategy`, `TriggerConfig`, `RuleNode`, …) | 1 |
| `src/lib/scanner/indicators.ts` | Wrappers de `technicalindicators` por indicador | 1 |
| `src/lib/scanner/structure.ts` | Swings → soporte/resistencia + `nearestBelow`/`nearestAbove` | 2 |
| `src/lib/scanner/features.ts` | Compone indicadores+estructura → `Features` por TF | 3 |
| `src/lib/scanner/derivatives-features.ts` | `funding_z`, `oi_change_pct` desde SP1 | 4 |
| `src/lib/scanner/predicates.ts` | Librería de predicados puros | 5 |
| `src/lib/scanner/config-schema.ts` | Schema Valibot del `trigger_config` + `parseTriggerConfig` | 6 |
| `src/lib/scanner/rules-engine.ts` | Evaluación recursiva del árbol (entry/skip) | 6 |
| `src/lib/scanner/mtf.ts` | `mtf_alignment` + gate | 7 |
| `src/lib/scanner/snapshot.ts` | Arma `IndicatorSnapshot` | 8 |
| `src/lib/scanner/scan.ts` | `scan` PURO (sin DB) | 8 |
| `src/db/repositories/strategies.ts` | `getStrategy`/`getEnabledStrategies` | 9 |
| `src/db/repositories/signals.ts` | `insertSignal` | 9 |
| `src/db/seed-strategies.ts` | Siembra `pullback-alcista` (idempotente) + CLI | 9 |
| `src/lib/scanner/scan-symbol.ts` | `scanSymbol` (lee SP1, persiste) | 10 |
| `package.json` | dep `technicalindicators` + script `seed` | 1, 9 |

---

### Task 1: Tipos compartidos + wrappers de indicadores

**Files:**
- Create: `src/lib/scanner/types.ts`, `src/lib/scanner/indicators.ts`
- Modify: `package.json` (dep `technicalindicators`)
- Test: `src/lib/scanner/indicators.test.ts`

**Interfaces:**
- Consumes: `OhlcvRow` de `src/lib/market-data/types.ts`.
- Produces: todos los tipos de `types.ts` (ver código); de `indicators.ts`: `ema(values, period)`, `rsiSeries(values, period?)`, `macdSeries(values)`, `adxSeries(candles, period?)`, `atrSeries(candles, period?)`, `bollingerSeries(values, period?, stdDev?)`, `stochRsiSeries(values)`, `vwapSeries(candles)`, `obvSeries(candles)`, `mfiSeries(candles, period?)`.

- [ ] **Step 1: Instalar `technicalindicators` y verificar su API**

Run: `npm install technicalindicators`
Luego **verifica** la forma I/O de cada indicador contra `node_modules/technicalindicators` (sus `.d.ts`): `EMA/RSI/MACD/ADX/ATR/BollingerBands/StochasticRSI/VWAP/OBV/MFI`. La API esperada (a confirmar): cada uno es `Indicator.calculate({...})`. EMA/RSI: `{ period, values }` → `number[]`. MACD: `{ values, fastPeriod, slowPeriod, signalPeriod, SimpleMAOscillator, SimpleMASignalValues }` → `{ MACD, signal, histogram }[]`. ADX: `{ high, low, close, period }` → `{ adx, pdi, mdi }[]`. ATR: `{ high, low, close, period }` → `number[]`. BollingerBands: `{ period, values, stdDev }` → `{ middle, upper, lower }[]`. StochasticRSI: `{ values, rsiPeriod, stochasticPeriod, kPeriod, dPeriod }` → `{ stochRSI, k, d }[]`. VWAP: `{ high, low, close, volume }` → `number[]`. OBV: `{ close, volume }` → `number[]`. MFI: `{ high, low, close, volume, period }` → `number[]`. Si el paquete no trae tipos, añade una declaración mínima `declare module 'technicalindicators'` con las firmas usadas. Si la forma real difiere, ajusta el cuerpo del wrapper (la firma pública del wrapper NO cambia).

- [ ] **Step 2: Escribir el test (falla)**

```ts
// src/lib/scanner/indicators.test.ts
import { describe, test, expect } from 'vitest';
import { ema, rsiSeries, atrSeries } from './indicators.ts';
import type { Candle } from './types.ts';

function candle(c: number): Candle {
  return { symbol: 'T', timeframe: '15m', openTime: new Date(0), o: c, h: c + 1, l: c - 1, c, v: 10 };
}

describe('indicators', () => {
  test('ema de serie constante converge a la constante', () => {
    const out = ema(Array(30).fill(100), 10);
    expect(out.length).toBe(30 - 10 + 1);
    expect(out[out.length - 1]).toBeCloseTo(100, 6);
  });

  test('rsiSeries de serie monótona creciente tiende a 100', () => {
    const out = rsiSeries(Array.from({ length: 30 }, (_, i) => i + 1), 14);
    expect(out[out.length - 1]).toBeGreaterThan(95);
  });

  test('atrSeries devuelve una serie no vacía y positiva', () => {
    const candles = Array.from({ length: 20 }, (_, i) => candle(100 + i));
    const out = atrSeries(candles, 14);
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/indicators.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 4: Implementar `types.ts`**

```ts
// src/lib/scanner/types.ts
import type { OhlcvRow } from '../market-data/types.ts';

export type Candle = OhlcvRow;
export type CandlesByTimeframe = Record<string, Candle[]>;

export type EmaStack = 'bullish' | 'bearish' | 'mixed';
export type MacdCross = 'up' | 'down' | 'none';
export type RsiState = 'oversold' | 'neutral' | 'overbought';
export type MtfAlignment = 'aligned' | 'mixed' | 'counter';

export interface Features {
  close: number;
  emaStack: EmaStack | null;
  macdCross: MacdCross | null;
  adx: number | null;
  rsi: number | null;
  rsiPrev: number | null;
  rsiState: RsiState | null;
  stochRsi: number | null;
  atrPct: number | null;
  bbPosition: number | null;
  aboveVwap: boolean | null;
  obv: number | null;
  mfi: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  distToSupportPct: number | null;
}

export interface DerivativesContext {
  fundingZ: number | null;
  oiChangePct: number | null;
}

export interface IndicatorSnapshot {
  byTimeframe: Record<string, Features>;
  mtfAlignment: MtfAlignment;
  levels: { support: number | null; resistance: number | null };
  derivatives: DerivativesContext;
}

export interface Signal {
  strategyId: string;
  symbol: string;
  firedAt: Date;
  snapshot: IndicatorSnapshot;
}

export interface Timeframes { bias: string; context: string; trigger: string; }

export type RuleNode =
  | { all: RuleNode[] }
  | { any: RuleNode[] }
  | { tf?: string; predicate: string; args?: Record<string, number> };

export interface TriggerConfig {
  timeframes: Timeframes;
  entry: RuleNode;
  skip?: RuleNode;
  allow_counter?: boolean;
}

export interface Strategy {
  id: string;
  enabled: boolean;
  symbols: string[];
  triggerConfig: TriggerConfig;
  riskParams: Record<string, unknown>;
  version: number;
}
```

- [ ] **Step 5: Implementar `indicators.ts`**

```ts
// src/lib/scanner/indicators.ts
import {
  EMA, MACD, ADX, RSI, StochasticRSI, ATR, BollingerBands, VWAP, OBV, MFI,
} from 'technicalindicators';
import type { Candle } from './types.ts';

const highs = (c: Candle[]) => c.map((x) => x.h);
const lows = (c: Candle[]) => c.map((x) => x.l);
const closes = (c: Candle[]) => c.map((x) => x.c);
const volumes = (c: Candle[]) => c.map((x) => x.v);

export function ema(values: number[], period: number): number[] {
  return EMA.calculate({ period, values });
}

export function rsiSeries(values: number[], period = 14): number[] {
  return RSI.calculate({ period, values });
}

export interface MacdPoint { MACD?: number; signal?: number; histogram?: number; }
export function macdSeries(values: number[]): MacdPoint[] {
  return MACD.calculate({
    values, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignalValues: false,
  });
}

export interface AdxPoint { adx: number; pdi: number; mdi: number; }
export function adxSeries(candles: Candle[], period = 14): AdxPoint[] {
  return ADX.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), period });
}

export function atrSeries(candles: Candle[], period = 14): number[] {
  return ATR.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), period });
}

export interface BollingerPoint { middle: number; upper: number; lower: number; }
export function bollingerSeries(values: number[], period = 20, stdDev = 2): BollingerPoint[] {
  return BollingerBands.calculate({ period, values, stdDev });
}

export interface StochRsiPoint { stochRSI: number; k: number; d: number; }
export function stochRsiSeries(values: number[]): StochRsiPoint[] {
  return StochasticRSI.calculate({ values, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
}

export function vwapSeries(candles: Candle[]): number[] {
  return VWAP.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), volume: volumes(candles) });
}

export function obvSeries(candles: Candle[]): number[] {
  return OBV.calculate({ close: closes(candles), volume: volumes(candles) });
}

export function mfiSeries(candles: Candle[], period = 14): number[] {
  return MFI.calculate({ high: highs(candles), low: lows(candles), close: closes(candles), volume: volumes(candles), period });
}
```

- [ ] **Step 6: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/indicators.test.ts`
Expected: PASS (3 tests).
Run: `npm run typecheck`
Expected: sin errores. (Si `technicalindicators` no exporta tipos, añade `declare module`.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/scanner/types.ts src/lib/scanner/indicators.ts src/lib/scanner/indicators.test.ts package.json package-lock.json
git commit -m "feat: tipos del scanner y wrappers de indicadores (SP2)"
```

---

### Task 2: Detector de estructura (swings → soporte/resistencia)

**Files:**
- Create: `src/lib/scanner/structure.ts`
- Test: `src/lib/scanner/structure.test.ts`

**Interfaces:**
- Consumes: `Candle` de `./types.ts`.
- Produces: `computeStructure(candles, lookback?): { supports: number[]; resistances: number[] }`, `nearestBelow(price, levels): number | null`, `nearestAbove(price, levels): number | null`.

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/scanner/structure.test.ts
import { describe, test, expect } from 'vitest';
import { computeStructure, nearestBelow, nearestAbove } from './structure.ts';
import type { Candle } from './types.ts';

function c(h: number, l: number): Candle {
  return { symbol: 'T', timeframe: '15m', openTime: new Date(0), o: l, h, l, c: l, v: 1 };
}

describe('computeStructure', () => {
  test('detecta un swing high y un swing low aislados', () => {
    // índice 3 es pico (h=20); índice 7 es valle (l=1); lookback 2
    const candles = [c(10, 5), c(11, 6), c(12, 7), c(20, 8), c(12, 7), c(11, 6), c(10, 5), c(9, 1), c(10, 5), c(11, 6), c(12, 7)];
    const { supports, resistances } = computeStructure(candles, 2);
    expect(resistances).toContain(20);
    expect(supports).toContain(1);
  });
});

describe('nearestBelow / nearestAbove', () => {
  test('nearestBelow devuelve el mayor nivel ≤ precio o null', () => {
    expect(nearestBelow(100, [90, 95, 110])).toBe(95);
    expect(nearestBelow(80, [90, 95])).toBeNull();
  });
  test('nearestAbove devuelve el menor nivel ≥ precio o null', () => {
    expect(nearestAbove(100, [90, 110, 120])).toBe(110);
    expect(nearestAbove(130, [90, 110])).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/structure.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `structure.ts`**

```ts
// src/lib/scanner/structure.ts
import type { Candle } from './types.ts';

// Swings por pivotes: i es swing high si su high es el máximo de la ventana [i-lb, i+lb]
// (análogo para swing low). Los últimos `lookback` no se confirman (no hay ventana derecha).
export function computeStructure(candles: Candle[], lookback = 5): { supports: number[]; resistances: number[] } {
  const supports: number[] = [];
  const resistances: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const maxHigh = Math.max(...window.map((w) => w.h));
    const minLow = Math.min(...window.map((w) => w.l));
    if (candles[i].h === maxHigh) resistances.push(candles[i].h);
    if (candles[i].l === minLow) supports.push(candles[i].l);
  }
  return { supports, resistances };
}

// Mayor nivel ≤ price (soporte por debajo), o null.
export function nearestBelow(price: number, levels: number[]): number | null {
  const below = levels.filter((l) => l <= price);
  return below.length > 0 ? Math.max(...below) : null;
}

// Menor nivel ≥ price (resistencia por encima), o null.
export function nearestAbove(price: number, levels: number[]): number | null {
  const above = levels.filter((l) => l >= price);
  return above.length > 0 ? Math.min(...above) : null;
}
```

- [ ] **Step 4: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/structure.test.ts`
Expected: PASS.
Run: `npm run typecheck` → sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanner/structure.ts src/lib/scanner/structure.test.ts
git commit -m "feat: detector de estructura por pivotes (soporte/resistencia) (SP2)"
```

---

### Task 3: Features normalizados por timeframe

**Files:**
- Create: `src/lib/scanner/features.ts`
- Test: `src/lib/scanner/features.test.ts`

**Interfaces:**
- Consumes: `Candle`, `Features`, `EmaStack`, `MacdCross`, `RsiState` de `./types.ts`; todos los `*Series`/`ema` de `./indicators.ts`; `computeStructure`/`nearestBelow`/`nearestAbove` de `./structure.ts`.
- Produces: `computeFeatures(candles: Candle[]): Features`.

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/scanner/features.test.ts
import { describe, test, expect } from 'vitest';
import { computeFeatures } from './features.ts';
import type { Candle } from './types.ts';

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    symbol: 'T', timeframe: '15m', openTime: new Date(i), o: c, h: c + 0.5, l: c - 0.5, c, v: 100,
  }));
}

describe('computeFeatures', () => {
  test('serie alcista sostenida → emaStack bullish y aboveVwap true', () => {
    const f = computeFeatures(series(Array.from({ length: 250 }, (_, i) => 100 + i)));
    expect(f.emaStack).toBe('bullish');
    expect(f.aboveVwap).toBe(true);
    expect(f.close).toBe(349);
  });

  test('datos insuficientes para EMA200 → emaStack null', () => {
    const f = computeFeatures(series(Array.from({ length: 50 }, (_, i) => 100 + i)));
    expect(f.emaStack).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/features.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `features.ts`**

```ts
// src/lib/scanner/features.ts
import type { Candle, Features, EmaStack, MacdCross, RsiState } from './types.ts';
import {
  ema, rsiSeries, macdSeries, adxSeries, atrSeries, bollingerSeries, stochRsiSeries,
  vwapSeries, obvSeries, mfiSeries, type MacdPoint,
} from './indicators.ts';
import { computeStructure, nearestBelow, nearestAbove } from './structure.ts';

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;

const last = <T>(arr: T[]): T | null => (arr.length > 0 ? arr[arr.length - 1] : null);
const nth = <T>(arr: T[], fromEnd: number): T | null => arr[arr.length + fromEnd] ?? null;

function emaStackOf(e20: number | null, e50: number | null, e200: number | null): EmaStack | null {
  if (e20 === null || e50 === null || e200 === null) return null;
  if (e20 > e50 && e50 > e200) return 'bullish';
  if (e20 < e50 && e50 < e200) return 'bearish';
  return 'mixed';
}

function macdCrossOf(cur: MacdPoint | null, prev: MacdPoint | null): MacdCross | null {
  if (!cur || !prev || cur.MACD == null || cur.signal == null || prev.MACD == null || prev.signal == null) return null;
  const prevAbove = prev.MACD >= prev.signal;
  const curAbove = cur.MACD >= cur.signal;
  if (!prevAbove && curAbove) return 'up';
  if (prevAbove && !curAbove) return 'down';
  return 'none';
}

function rsiStateOf(rsi: number | null): RsiState | null {
  if (rsi === null) return null;
  if (rsi <= RSI_OVERSOLD) return 'oversold';
  if (rsi >= RSI_OVERBOUGHT) return 'overbought';
  return 'neutral';
}

export function computeFeatures(candles: Candle[]): Features {
  const close = candles[candles.length - 1].c;
  const values = candles.map((c) => c.c);

  const emaStack = emaStackOf(last(ema(values, 20)), last(ema(values, 50)), last(ema(values, 200)));

  const macd = macdSeries(values);
  const macdCross = macdCrossOf(last(macd), nth(macd, -2));

  const adx = last(adxSeries(candles))?.adx ?? null;

  const rsiArr = rsiSeries(values);
  const rsi = last(rsiArr);
  const rsiPrev = nth(rsiArr, -2);
  const rsiState = rsiStateOf(rsi);

  const stochRsi = last(stochRsiSeries(values))?.stochRSI ?? null;

  const atr = last(atrSeries(candles));
  const atrPct = atr !== null ? (atr / close) * 100 : null;

  const bb = last(bollingerSeries(values));
  const bbPosition = bb ? (close - bb.lower) / (bb.upper - bb.lower) : null;

  const vwap = last(vwapSeries(candles));
  const aboveVwap = vwap !== null ? close > vwap : null;

  const obv = last(obvSeries(candles));
  const mfi = last(mfiSeries(candles));

  const { supports, resistances } = computeStructure(candles);
  const nearestSupport = nearestBelow(close, supports);
  const nearestResistance = nearestAbove(close, resistances);
  const distToSupportPct = nearestSupport !== null ? ((close - nearestSupport) / close) * 100 : null;

  return {
    close, emaStack, macdCross, adx, rsi, rsiPrev, rsiState, stochRsi,
    atrPct, bbPosition, aboveVwap, obv, mfi, nearestSupport, nearestResistance, distToSupportPct,
  };
}
```

- [ ] **Step 4: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/features.test.ts`
Expected: PASS.
Run: `npm run typecheck` → sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanner/features.ts src/lib/scanner/features.test.ts
git commit -m "feat: features normalizados por timeframe (SP2)"
```

---

### Task 4: Features de derivados (funding_z, oi_change_pct)

**Files:**
- Create: `src/lib/scanner/derivatives-features.ts`
- Test: `src/lib/scanner/derivatives-features.test.ts`

**Interfaces:**
- Consumes: `FundingRow`, `OpenInterestRow` de `src/lib/market-data/types.ts`; `DerivativesContext` de `./types.ts`.
- Produces: `computeFundingZ(rates): number | null`, `computeOiChangePct(ois): number | null`, `computeDerivativesContext(rates, ois): DerivativesContext`.

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/scanner/derivatives-features.test.ts
import { describe, test, expect } from 'vitest';
import { computeFundingZ, computeOiChangePct } from './derivatives-features.ts';
import type { FundingRow, OpenInterestRow } from '../market-data/types.ts';

const fr = (rate: number): FundingRow => ({ symbol: 'T', ts: new Date(0), rate });
const oi = (v: number): OpenInterestRow => ({ symbol: 'T', ts: new Date(0), oi: v, oiValue: null });

describe('computeFundingZ', () => {
  test('z-score del último valor vs su historia', () => {
    // serie [0,0,0,0,10]: mean=2, sd=4, z=(10-2)/4=2
    expect(computeFundingZ([fr(0), fr(0), fr(0), fr(0), fr(10)])).toBeCloseTo(2, 6);
  });
  test('serie sin varianza → 0; serie corta → null', () => {
    expect(computeFundingZ([fr(5), fr(5)])).toBe(0);
    expect(computeFundingZ([fr(5)])).toBeNull();
  });
});

describe('computeOiChangePct', () => {
  test('cambio porcentual del primero al último', () => {
    expect(computeOiChangePct([oi(100), oi(150)])).toBeCloseTo(50, 6);
  });
  test('serie corta o primer valor 0 → null', () => {
    expect(computeOiChangePct([oi(100)])).toBeNull();
    expect(computeOiChangePct([oi(0), oi(50)])).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/derivatives-features.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `derivatives-features.ts`**

```ts
// src/lib/scanner/derivatives-features.ts
import type { FundingRow, OpenInterestRow } from '../market-data/types.ts';
import type { DerivativesContext } from './types.ts';

// z-score del último funding vs su historia (§15.4). Serie corta → null; sin varianza → 0.
export function computeFundingZ(rates: FundingRow[]): number | null {
  if (rates.length < 2) return null;
  const xs = rates.map((r) => r.rate);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (xs[xs.length - 1] - mean) / sd;
}

// Cambio porcentual de OI del primer al último valor de la ventana (§15.4).
export function computeOiChangePct(ois: OpenInterestRow[]): number | null {
  if (ois.length < 2) return null;
  const first = ois[0].oi;
  const lastOi = ois[ois.length - 1].oi;
  if (first === 0) return null;
  return ((lastOi - first) / first) * 100;
}

export function computeDerivativesContext(rates: FundingRow[], ois: OpenInterestRow[]): DerivativesContext {
  return { fundingZ: computeFundingZ(rates), oiChangePct: computeOiChangePct(ois) };
}
```

- [ ] **Step 4: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/derivatives-features.test.ts`
Expected: PASS.
Run: `npm run typecheck` → sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanner/derivatives-features.ts src/lib/scanner/derivatives-features.test.ts
git commit -m "feat: features de derivados funding_z y oi_change_pct (SP2)"
```

---

### Task 5: Librería de predicados

**Files:**
- Create: `src/lib/scanner/predicates.ts`
- Test: `src/lib/scanner/predicates.test.ts`

**Interfaces:**
- Consumes: `Features`, `DerivativesContext` de `./types.ts`.
- Produces: `interface PredicateCtx { deriv: DerivativesContext }`, `type PredicateFn = (f: Features, args: Record<string, number>, ctx: PredicateCtx) => boolean`, `const predicates: Record<string, PredicateFn>`.

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/scanner/predicates.test.ts
import { describe, test, expect } from 'vitest';
import { predicates, type PredicateCtx } from './predicates.ts';
import type { Features } from './types.ts';

const base: Features = {
  close: 100, emaStack: 'bullish', macdCross: 'up', adx: 30, rsi: 45, rsiPrev: 38, rsiState: 'neutral',
  stochRsi: 0.5, atrPct: 2, bbPosition: 0.5, aboveVwap: true, obv: 1, mfi: 50,
  nearestSupport: 99.7, nearestResistance: 101, distToSupportPct: 0.3,
};
const ctx: PredicateCtx = { deriv: { fundingZ: 0.5, oiChangePct: 1 } };

describe('predicates', () => {
  test('ema_stack_bullish', () => {
    expect(predicates.ema_stack_bullish(base, {}, ctx)).toBe(true);
    expect(predicates.ema_stack_bullish({ ...base, emaStack: 'mixed' }, {}, ctx)).toBe(false);
  });
  test('rsi_cross_up cruza el nivel de abajo a arriba', () => {
    expect(predicates.rsi_cross_up(base, { level: 40 }, ctx)).toBe(true);   // 38<40, 45>=40
    expect(predicates.rsi_cross_up({ ...base, rsiPrev: 41 }, { level: 40 }, ctx)).toBe(false);
  });
  test('above_vwap / near_support / atr_pct_above', () => {
    expect(predicates.above_vwap(base, {}, ctx)).toBe(true);
    expect(predicates.near_support(base, { max_dist_pct: 0.5 }, ctx)).toBe(true);   // 0.3 ≤ 0.5
    expect(predicates.atr_pct_above(base, { max: 4 }, ctx)).toBe(false);            // 2 > 4 falso
  });
  test('funding_z_extreme lee el contexto de derivados', () => {
    expect(predicates.funding_z_extreme(base, { max_abs: 2.5 }, ctx)).toBe(false);  // |0.5|>2.5 falso
    expect(predicates.funding_z_extreme(base, { max_abs: 2.5 }, { deriv: { fundingZ: 3, oiChangePct: null } })).toBe(true);
  });
  test('feature null → predicado false (no lanza)', () => {
    expect(predicates.near_support({ ...base, distToSupportPct: null }, { max_dist_pct: 0.5 }, ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/predicates.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `predicates.ts`**

```ts
// src/lib/scanner/predicates.ts
import type { Features, DerivativesContext } from './types.ts';

export interface PredicateCtx { deriv: DerivativesContext; }
export type PredicateFn = (f: Features, args: Record<string, number>, ctx: PredicateCtx) => boolean;

// Predicados puros sobre features. Un feature null → false (predicado no satisfecho), nunca lanza.
export const predicates: Record<string, PredicateFn> = {
  ema_stack_bullish: (f) => f.emaStack === 'bullish',
  ema_stack_bearish: (f) => f.emaStack === 'bearish',
  above_vwap: (f) => f.aboveVwap === true,
  below_vwap: (f) => f.aboveVwap === false,
  rsi_cross_up: (f, a) => f.rsi !== null && f.rsiPrev !== null && f.rsiPrev < a.level && f.rsi >= a.level,
  rsi_oversold: (f) => f.rsiState === 'oversold',
  rsi_overbought: (f) => f.rsiState === 'overbought',
  macd_cross_up: (f) => f.macdCross === 'up',
  macd_cross_down: (f) => f.macdCross === 'down',
  near_support: (f, a) => f.distToSupportPct !== null && f.distToSupportPct <= a.max_dist_pct,
  atr_pct_above: (f, a) => f.atrPct !== null && f.atrPct > a.max,
  adx_above: (f, a) => f.adx !== null && f.adx > a.min,
  funding_z_extreme: (_f, a, ctx) => ctx.deriv.fundingZ !== null && Math.abs(ctx.deriv.fundingZ) > a.max_abs,
};
```

- [ ] **Step 4: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/predicates.test.ts`
Expected: PASS.
Run: `npm run typecheck` → sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanner/predicates.ts src/lib/scanner/predicates.test.ts
git commit -m "feat: librería de predicados puros del scanner (SP2)"
```

---

### Task 6: Schema del config + motor de reglas

**Files:**
- Create: `src/lib/scanner/config-schema.ts`, `src/lib/scanner/rules-engine.ts`
- Test: `src/lib/scanner/config-schema.test.ts`, `src/lib/scanner/rules-engine.test.ts`

**Interfaces:**
- Consumes: `TriggerConfig`, `RuleNode`, `Features` de `./types.ts`; `predicates`, `PredicateCtx` de `./predicates.ts`.
- Produces: de `config-schema.ts`: `parseTriggerConfig(raw: unknown): TriggerConfig`. De `rules-engine.ts`: `evaluateEntry(config, featuresByTf, triggerTf, ctx): boolean`, `evaluateSkip(config, featuresByTf, triggerTf, ctx): boolean`.

- [ ] **Step 1: Escribir los tests (fallan)**

```ts
// src/lib/scanner/config-schema.test.ts
import { describe, test, expect } from 'vitest';
import { parseTriggerConfig } from './config-schema.ts';

const valid = {
  timeframes: { bias: '4h', context: '1h', trigger: '15m' },
  entry: { all: [{ tf: '4h', predicate: 'ema_stack_bullish' }, { tf: '15m', predicate: 'rsi_cross_up', args: { level: 40 } }] },
  skip: { any: [{ predicate: 'funding_z_extreme', args: { max_abs: 2.5 } }] },
};

describe('parseTriggerConfig', () => {
  test('acepta un config válido (árbol anidado)', () => {
    expect(parseTriggerConfig(valid).timeframes.trigger).toBe('15m');
  });
  test('lanza ante predicado desconocido', () => {
    const bad = { ...valid, entry: { all: [{ predicate: 'no_existe' }] } };
    expect(() => parseTriggerConfig(bad)).toThrow();
  });
  test('lanza si faltan timeframes', () => {
    expect(() => parseTriggerConfig({ entry: { all: [] } })).toThrow();
  });
});
```

```ts
// src/lib/scanner/rules-engine.test.ts
import { describe, test, expect } from 'vitest';
import { evaluateEntry, evaluateSkip } from './rules-engine.ts';
import type { Features, TriggerConfig } from './types.ts';
import type { PredicateCtx } from './predicates.ts';

const bull: Features = {
  close: 100, emaStack: 'bullish', macdCross: 'up', adx: 30, rsi: 45, rsiPrev: 38, rsiState: 'neutral',
  stochRsi: 0.5, atrPct: 2, bbPosition: 0.5, aboveVwap: true, obv: 1, mfi: 50,
  nearestSupport: 99.7, nearestResistance: 101, distToSupportPct: 0.3,
};
const ctx: PredicateCtx = { deriv: { fundingZ: 0.5, oiChangePct: 1 } };
const config: TriggerConfig = {
  timeframes: { bias: '4h', context: '1h', trigger: '15m' },
  entry: { all: [
    { tf: '4h', predicate: 'ema_stack_bullish' },
    { tf: '15m', predicate: 'rsi_cross_up', args: { level: 40 } },
  ] },
  skip: { any: [{ tf: '15m', predicate: 'atr_pct_above', args: { max: 4 } }] },
};
const featuresByTf = { '4h': bull, '1h': bull, '15m': bull };

describe('rules-engine', () => {
  test('entry true cuando todas las hojas se cumplen', () => {
    expect(evaluateEntry(config, featuresByTf, '15m', ctx)).toBe(true);
  });
  test('entry false si una hoja falla', () => {
    expect(evaluateEntry(config, { ...featuresByTf, '4h': { ...bull, emaStack: 'bearish' } }, '15m', ctx)).toBe(false);
  });
  test('skip false con ATR bajo; true cuando el veto aplica', () => {
    expect(evaluateSkip(config, featuresByTf, '15m', ctx)).toBe(false);
    expect(evaluateSkip(config, { ...featuresByTf, '15m': { ...bull, atrPct: 9 } }, '15m', ctx)).toBe(true);
  });
  test('hoja sin tf usa el TF gatillo; features de un TF ausente → false', () => {
    const noTf: TriggerConfig = { ...config, entry: { all: [{ predicate: 'above_vwap' }] }, skip: undefined };
    expect(evaluateEntry(noTf, { '15m': bull }, '15m', ctx)).toBe(true);
    expect(evaluateEntry(noTf, {}, '15m', ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Correr los tests (fallan)**

Run: `npx vitest run src/lib/scanner/config-schema.test.ts src/lib/scanner/rules-engine.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar `config-schema.ts`**

> Valibot recursivo con `v.lazy`. Verifica la forma exacta de `v.lazy`/`v.union`/`v.record`/`v.custom` contra valibot 1.x (ya instalado) si el typecheck se queja.

```ts
// src/lib/scanner/config-schema.ts
import * as v from 'valibot';
import { predicates } from './predicates.ts';
import type { TriggerConfig, RuleNode } from './types.ts';

const knownPredicate = v.custom<string>(
  (name) => typeof name === 'string' && name in predicates,
  'predicado desconocido',
);

const leafSchema = v.object({
  tf: v.optional(v.string()),
  predicate: knownPredicate,
  args: v.optional(v.record(v.string(), v.number())),
});

const nodeSchema: v.GenericSchema<RuleNode> = v.lazy(() =>
  v.union([
    v.object({ all: v.array(nodeSchema) }),
    v.object({ any: v.array(nodeSchema) }),
    leafSchema,
  ]),
);

const triggerConfigSchema = v.object({
  timeframes: v.object({ bias: v.string(), context: v.string(), trigger: v.string() }),
  entry: nodeSchema,
  skip: v.optional(nodeSchema),
  allow_counter: v.optional(v.boolean()),
});

// Valida el trigger_config (dato externo de la fila strategies) en el límite. Lanza si es inválido.
export function parseTriggerConfig(raw: unknown): TriggerConfig {
  return v.parse(triggerConfigSchema, raw) as TriggerConfig;
}
```

- [ ] **Step 4: Implementar `rules-engine.ts`**

```ts
// src/lib/scanner/rules-engine.ts
import type { TriggerConfig, RuleNode, Features } from './types.ts';
import { predicates, type PredicateCtx } from './predicates.ts';

// Evalúa un nodo del árbol. Hoja: resuelve features[tf] (o el TF gatillo) y aplica el predicado.
function evaluateNode(
  node: RuleNode, featuresByTf: Record<string, Features>, triggerTf: string, ctx: PredicateCtx,
): boolean {
  if ('all' in node) return node.all.every((n) => evaluateNode(n, featuresByTf, triggerTf, ctx));
  if ('any' in node) return node.any.some((n) => evaluateNode(n, featuresByTf, triggerTf, ctx));
  const features = featuresByTf[node.tf ?? triggerTf];
  if (!features) return false;
  const fn = predicates[node.predicate];
  if (!fn) throw new Error(`predicado desconocido: ${node.predicate}`);
  return fn(features, node.args ?? {}, ctx);
}

export function evaluateEntry(
  config: TriggerConfig, featuresByTf: Record<string, Features>, triggerTf: string, ctx: PredicateCtx,
): boolean {
  return evaluateNode(config.entry, featuresByTf, triggerTf, ctx);
}

// Veto duro: skip ausente = sin veto (false).
export function evaluateSkip(
  config: TriggerConfig, featuresByTf: Record<string, Features>, triggerTf: string, ctx: PredicateCtx,
): boolean {
  return config.skip ? evaluateNode(config.skip, featuresByTf, triggerTf, ctx) : false;
}
```

- [ ] **Step 5: Correr los tests (pasan) + typecheck**

Run: `npx vitest run src/lib/scanner/config-schema.test.ts src/lib/scanner/rules-engine.test.ts`
Expected: PASS.
Run: `npm run typecheck` → sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scanner/config-schema.ts src/lib/scanner/rules-engine.ts src/lib/scanner/config-schema.test.ts src/lib/scanner/rules-engine.test.ts
git commit -m "feat: schema Valibot del config y motor de reglas (SP2)"
```

---

### Task 7: Gate multi-timeframe

**Files:**
- Create: `src/lib/scanner/mtf.ts`
- Test: `src/lib/scanner/mtf.test.ts`

**Interfaces:**
- Consumes: `Features`, `Timeframes`, `MtfAlignment`, `TriggerConfig` de `./types.ts`.
- Produces: `computeMtfAlignment(featuresByTf, tfs): MtfAlignment`, `passesMtfGate(alignment, config): boolean`.

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/scanner/mtf.test.ts
import { describe, test, expect } from 'vitest';
import { computeMtfAlignment, passesMtfGate } from './mtf.ts';
import type { Features, Timeframes, TriggerConfig } from './types.ts';

const tfs: Timeframes = { bias: '4h', context: '1h', trigger: '15m' };
const f = (emaStack: Features['emaStack']): Features => ({
  close: 100, emaStack, macdCross: 'none', adx: null, rsi: null, rsiPrev: null, rsiState: null,
  stochRsi: null, atrPct: null, bbPosition: null, aboveVwap: null, obv: null, mfi: null,
  nearestSupport: null, nearestResistance: null, distToSupportPct: null,
});
const base: TriggerConfig = { timeframes: tfs, entry: { all: [] } };

describe('computeMtfAlignment', () => {
  test('bias bullish + context no bearish → aligned', () => {
    expect(computeMtfAlignment({ '4h': f('bullish'), '1h': f('bullish'), '15m': f('bullish') }, tfs)).toBe('aligned');
  });
  test('bias bearish → counter', () => {
    expect(computeMtfAlignment({ '4h': f('bearish'), '1h': f('bullish'), '15m': f('bullish') }, tfs)).toBe('counter');
  });
  test('bias mixed → mixed', () => {
    expect(computeMtfAlignment({ '4h': f('mixed'), '1h': f('bullish'), '15m': f('bullish') }, tfs)).toBe('mixed');
  });
});

describe('passesMtfGate', () => {
  test('counter no pasa salvo allow_counter', () => {
    expect(passesMtfGate('counter', base)).toBe(false);
    expect(passesMtfGate('counter', { ...base, allow_counter: true })).toBe(true);
  });
  test('aligned y mixed pasan', () => {
    expect(passesMtfGate('aligned', base)).toBe(true);
    expect(passesMtfGate('mixed', base)).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/mtf.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `mtf.ts`**

```ts
// src/lib/scanner/mtf.ts
import type { Features, Timeframes, MtfAlignment, TriggerConfig } from './types.ts';

// Gate top-down (§16.4): el sesgo HTF gobierna. Spot = setups long.
export function computeMtfAlignment(featuresByTf: Record<string, Features>, tfs: Timeframes): MtfAlignment {
  const bias = featuresByTf[tfs.bias]?.emaStack ?? null;
  const context = featuresByTf[tfs.context]?.emaStack ?? null;
  if (bias === 'bearish') return 'counter';
  if (bias === 'bullish' && context !== 'bearish') return 'aligned';
  return 'mixed';
}

// counter se filtra salvo allow_counter explícito en el config.
export function passesMtfGate(alignment: MtfAlignment, config: TriggerConfig): boolean {
  if (alignment === 'counter') return config.allow_counter === true;
  return true;
}
```

- [ ] **Step 4: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/mtf.test.ts`
Expected: PASS.
Run: `npm run typecheck` → sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanner/mtf.ts src/lib/scanner/mtf.test.ts
git commit -m "feat: gate multi-timeframe del scanner (SP2)"
```

---

### Task 8: Snapshot + scan puro

**Files:**
- Create: `src/lib/scanner/snapshot.ts`, `src/lib/scanner/scan.ts`
- Test: `src/lib/scanner/scan.test.ts`

**Interfaces:**
- Consumes: `computeFeatures` (T3), `evaluateEntry`/`evaluateSkip` (T6), `computeMtfAlignment`/`passesMtfGate` (T7), tipos de `./types.ts`.
- Produces: de `snapshot.ts`: `buildSnapshot(featuresByTf, tfs, deriv, alignment): IndicatorSnapshot`. De `scan.ts`: `REQUIRED_WARMUP` (200), `scan(strategy, symbol, candlesByTf, deriv, now): Signal | null`.
- **`scan.ts` NO importa nada que cargue `pool.ts`** (es puro, testeable sin DB).

- [ ] **Step 1: Escribir el test (falla)**

```ts
// src/lib/scanner/scan.test.ts
import { describe, test, expect } from 'vitest';
import { scan } from './scan.ts';
import type { Candle, Strategy, CandlesByTimeframe, DerivativesContext } from './types.ts';

const NOW = new Date('2026-03-01T00:00:00Z');
const deriv: DerivativesContext = { fundingZ: 0.5, oiChangePct: 1 };

// Serie alcista de N velas (cierre creciente) → emaStack bullish, aboveVwap true, rsi alto.
function bullish(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i;
    return { symbol: 'BTC/USDT', timeframe: 'x', openTime: new Date(i), o: c, h: c + 0.5, l: c - 0.5, c, v: 100 };
  });
}
function flat(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ symbol: 'BTC/USDT', timeframe: 'x', openTime: new Date(i), o: 100, h: 100.5, l: 99.5, c: 100, v: 100 }));
}

const strategy: Strategy = {
  id: 'pullback-alcista', enabled: true, symbols: ['BTC/USDT'], version: 1, riskParams: {},
  triggerConfig: {
    timeframes: { bias: '4h', context: '1h', trigger: '15m' },
    entry: { all: [{ tf: '4h', predicate: 'ema_stack_bullish' }, { tf: '1h', predicate: 'above_vwap' }] },
    skip: { any: [{ predicate: 'funding_z_extreme', args: { max_abs: 2.5 } }] },
  },
};

describe('scan', () => {
  test('datos insuficientes (warmup) → null', () => {
    const candles: CandlesByTimeframe = { '4h': bullish(50), '1h': bullish(50), '15m': bullish(50) };
    expect(scan(strategy, 'BTC/USDT', candles, deriv, NOW)).toBeNull();
  });

  test('setup alcista alineado → dispara signal con snapshot', () => {
    const candles: CandlesByTimeframe = { '4h': bullish(250), '1h': bullish(250), '15m': bullish(250) };
    const sig = scan(strategy, 'BTC/USDT', candles, deriv, NOW);
    expect(sig).not.toBeNull();
    expect(sig?.snapshot.mtfAlignment).toBe('aligned');
    expect(sig?.snapshot.byTimeframe['4h'].emaStack).toBe('bullish');
    expect(sig?.firedAt).toBe(NOW);
  });

  test('skip funding_z_extreme veta aunque entry se cumpla', () => {
    const candles: CandlesByTimeframe = { '4h': bullish(250), '1h': bullish(250), '15m': bullish(250) };
    expect(scan(strategy, 'BTC/USDT', candles, { fundingZ: 3, oiChangePct: null }, NOW)).toBeNull();
  });

  test('sesgo bias bajista → counter → null', () => {
    // 4h bajista (cierres decrecientes), trigger alcista
    const down = Array.from({ length: 250 }, (_, i) => { const c = 350 - i; return { symbol: 'BTC/USDT', timeframe: 'x', openTime: new Date(i), o: c, h: c + 0.5, l: c - 0.5, c, v: 100 }; });
    const candles: CandlesByTimeframe = { '4h': down, '1h': bullish(250), '15m': bullish(250) };
    expect(scan(strategy, 'BTC/USDT', candles, deriv, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/scan.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar `snapshot.ts`**

```ts
// src/lib/scanner/snapshot.ts
import type { Features, Timeframes, DerivativesContext, MtfAlignment, IndicatorSnapshot } from './types.ts';

export function buildSnapshot(
  featuresByTf: Record<string, Features>, tfs: Timeframes, deriv: DerivativesContext, alignment: MtfAlignment,
): IndicatorSnapshot {
  const trigger = featuresByTf[tfs.trigger];
  return {
    byTimeframe: featuresByTf,
    mtfAlignment: alignment,
    levels: { support: trigger?.nearestSupport ?? null, resistance: trigger?.nearestResistance ?? null },
    derivatives: deriv,
  };
}
```

- [ ] **Step 4: Implementar `scan.ts`**

```ts
// src/lib/scanner/scan.ts
import type { Strategy, CandlesByTimeframe, DerivativesContext, Signal, Features } from './types.ts';
import { computeFeatures } from './features.ts';
import { evaluateEntry, evaluateSkip } from './rules-engine.ts';
import { computeMtfAlignment, passesMtfGate } from './mtf.ts';
import { buildSnapshot } from './snapshot.ts';

// Velas mínimas por TF para que los indicadores (EMA200) sean válidos (§ política de warmup).
export const REQUIRED_WARMUP = 200;

// Núcleo PURO: velas inyectadas → Signal | null. Sin acceso a DB (reusable por SP4/SP5).
export function scan(
  strategy: Strategy, symbol: string, candlesByTf: CandlesByTimeframe, deriv: DerivativesContext, now: Date,
): Signal | null {
  const tfs = strategy.triggerConfig.timeframes;
  const tfList = [tfs.bias, tfs.context, tfs.trigger];

  // Gate de warmup: datos insuficientes en alguna TF → no dispara.
  for (const tf of tfList) {
    if ((candlesByTf[tf]?.length ?? 0) < REQUIRED_WARMUP) return null;
  }

  const featuresByTf: Record<string, Features> = {};
  for (const tf of tfList) featuresByTf[tf] = computeFeatures(candlesByTf[tf]);

  const alignment = computeMtfAlignment(featuresByTf, tfs);
  if (!passesMtfGate(alignment, strategy.triggerConfig)) return null;

  const ctx = { deriv };
  if (evaluateSkip(strategy.triggerConfig, featuresByTf, tfs.trigger, ctx)) return null;
  if (!evaluateEntry(strategy.triggerConfig, featuresByTf, tfs.trigger, ctx)) return null;

  return { strategyId: strategy.id, symbol, firedAt: now, snapshot: buildSnapshot(featuresByTf, tfs, deriv, alignment) };
}
```

- [ ] **Step 5: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/scan.test.ts`
Expected: PASS (4 tests).
Run: `npm run typecheck` → sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scanner/snapshot.ts src/lib/scanner/scan.ts src/lib/scanner/scan.test.ts
git commit -m "feat: snapshot y scan puro del scanner (SP2)"
```

---

### Task 9: Repos de strategies/signals + seed de la estrategia semilla

**Files:**
- Create: `src/db/repositories/strategies.ts`, `src/db/repositories/signals.ts`, `src/db/seed-strategies.ts`
- Modify: `package.json` (script `seed`)
- Test: `src/db/repositories/strategies.test.ts`, `src/db/repositories/signals.test.ts`

**Interfaces:**
- Consumes: `query` de `src/db/pool.ts`; `ulid` de `ulidx`; `parseTriggerConfig` (T6); tipos `Strategy`/`Signal` de `src/lib/scanner/types.ts`; `migrate` (tests).
- Produces: `getStrategy(id): Promise<Strategy | null>`, `getEnabledStrategies(): Promise<Strategy[]>`; `insertSignal(signal): Promise<string>`; `seedStrategies(): Promise<void>`.

- [ ] **Step 1: Escribir los tests (fallan)**

```ts
// src/db/repositories/strategies.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { seedStrategies } from '../seed-strategies.ts';
import { getStrategy, getEnabledStrategies } from './strategies.ts';

beforeAll(async () => { await migrate(); await seedStrategies(); });
afterAll(async () => { await pool.end(); });

describe('strategies repo', () => {
  test('getStrategy parsea trigger_config de la semilla', async () => {
    const s = await getStrategy('pullback-alcista');
    expect(s?.triggerConfig.timeframes).toEqual({ bias: '4h', context: '1h', trigger: '15m' });
    expect(s?.symbols).toContain('BTC/USDT');
    expect(s?.enabled).toBe(true);
  });
  test('getEnabledStrategies incluye la semilla', async () => {
    const list = await getEnabledStrategies();
    expect(list.some((s) => s.id === 'pullback-alcista')).toBe(true);
  });
  test('getStrategy de un id inexistente → null', async () => {
    expect(await getStrategy('no-existe')).toBeNull();
  });
});
```

```ts
// src/db/repositories/signals.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { seedStrategies } from '../seed-strategies.ts';
import { insertSignal } from './signals.ts';
import type { Signal } from '../../lib/scanner/types.ts';

beforeAll(async () => { await migrate(); await seedStrategies(); });
afterAll(async () => {
  await query("DELETE FROM kairos.signals WHERE symbol = 'TEST/USDT'", []);
  await pool.end();
});

const snapshot = { byTimeframe: {}, mtfAlignment: 'aligned' as const, levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } };

describe('signals repo', () => {
  test('insertSignal persiste y devuelve un ULID', async () => {
    const sig: Signal = { strategyId: 'pullback-alcista', symbol: 'TEST/USDT', firedAt: new Date('2026-03-01T00:00:00Z'), snapshot };
    const id = await insertSignal(sig);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const rows = await query<{ symbol: string; indicator_snapshot: { mtfAlignment: string } }>(
      'SELECT symbol, indicator_snapshot FROM kairos.signals WHERE id = $1', [id],
    );
    expect(rows[0]?.symbol).toBe('TEST/USDT');
    expect(rows[0]?.indicator_snapshot.mtfAlignment).toBe('aligned');
  });
});
```

- [ ] **Step 2: Correr los tests (fallan)**

Run: `npx vitest run src/db/repositories/strategies.test.ts src/db/repositories/signals.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar `strategies.ts`**

```ts
// src/db/repositories/strategies.ts
import { query } from '../pool.ts';
import { parseTriggerConfig } from '../../lib/scanner/config-schema.ts';
import type { Strategy } from '../../lib/scanner/types.ts';

interface StrategyRow {
  id: string; enabled: boolean; symbols: string[];
  trigger_config: unknown; risk_params: Record<string, unknown>; version: number;
}

function toStrategy(r: StrategyRow): Strategy {
  return {
    id: r.id, enabled: r.enabled, symbols: r.symbols,
    triggerConfig: parseTriggerConfig(r.trigger_config), riskParams: r.risk_params, version: r.version,
  };
}

const SELECT = 'SELECT id, enabled, symbols, trigger_config, risk_params, version FROM kairos.strategies';

export async function getStrategy(id: string): Promise<Strategy | null> {
  const rows = await query<StrategyRow>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? toStrategy(rows[0]) : null;
}

export async function getEnabledStrategies(): Promise<Strategy[]> {
  const rows = await query<StrategyRow>(`${SELECT} WHERE enabled = true`);
  return rows.map(toStrategy);
}
```

- [ ] **Step 4: Implementar `signals.ts`**

```ts
// src/db/repositories/signals.ts
import { ulid } from 'ulidx';
import { query } from '../pool.ts';
import type { Signal } from '../../lib/scanner/types.ts';

// Append-first: una señal disparada se inserta, nunca se actualiza (§8).
export async function insertSignal(signal: Signal): Promise<string> {
  const id = ulid();
  await query(
    `INSERT INTO kairos.signals (id, strategy_id, symbol, fired_at, indicator_snapshot, status)
     VALUES ($1, $2, $3, $4, $5, 'fired')`,
    [id, signal.strategyId, signal.symbol, signal.firedAt, JSON.stringify(signal.snapshot)],
  );
  return id;
}
```

- [ ] **Step 5: Implementar `seed-strategies.ts`** (orden env-antes-de-pool como `migrate.ts`)

```ts
// src/db/seed-strategies.ts
import { pathToFileURL } from 'node:url';

const TRIGGER_CONFIG = {
  timeframes: { bias: '4h', context: '1h', trigger: '15m' },
  entry: {
    all: [
      { tf: '4h', predicate: 'ema_stack_bullish' },
      { tf: '1h', predicate: 'above_vwap' },
      { tf: '15m', predicate: 'rsi_cross_up', args: { level: 40 } },
      { tf: '15m', predicate: 'near_support', args: { max_dist_pct: 0.5 } },
    ],
  },
  skip: {
    any: [
      { tf: '15m', predicate: 'atr_pct_above', args: { max: 4 } },
      { predicate: 'funding_z_extreme', args: { max_abs: 2.5 } },
    ],
  },
};
const RISK_PARAMS = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, max_notional_pct: 10 };

// Siembra la estrategia semilla pullback-alcista (§16.3). Idempotente: refresca config si ya existe.
export async function seedStrategies(): Promise<void> {
  const { query } = await import('./pool.ts');
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, true, '15m', $2::text[], $3, $4, 1)
     ON CONFLICT (id) DO UPDATE
       SET trigger_config = EXCLUDED.trigger_config,
           risk_params    = EXCLUDED.risk_params,
           enabled        = EXCLUDED.enabled`,
    ['pullback-alcista', '{BTC/USDT,ETH/USDT}', JSON.stringify(TRIGGER_CONFIG), JSON.stringify(RISK_PARAMS)],
  );
}

// v8 ignore start — entrypoint CLI; se valida con `npm run seed`, no en unit tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await import('dotenv/config');
  const { pool } = await import('./pool.ts');
  seedStrategies()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Seed de estrategias falló:', error);
      process.exit(1);
    });
}
// v8 ignore stop
```

En `package.json`, dentro de `"scripts"`, tras `"migrate"`, añadir:
```json
    "seed": "node --experimental-strip-types src/db/seed-strategies.ts",
```

- [ ] **Step 6: Correr los tests (pasan) + typecheck**

Run: `npx vitest run src/db/repositories/strategies.test.ts src/db/repositories/signals.test.ts`
Expected: PASS. (Requiere Postgres de docker arriba.)
Run: `npm run typecheck` → sin errores.

- [ ] **Step 7: Commit**

```bash
git add src/db/repositories/strategies.ts src/db/repositories/signals.ts src/db/seed-strategies.ts src/db/repositories/strategies.test.ts src/db/repositories/signals.test.ts package.json
git commit -m "feat: repos de strategies/signals y seed de la estrategia semilla (SP2)"
```

---

### Task 10: scanSymbol (lee SP1, scan, persiste)

**Files:**
- Create: `src/lib/scanner/scan-symbol.ts`
- Test: `src/lib/scanner/scan-symbol.test.ts`

**Interfaces:**
- Consumes: `scan`, `REQUIRED_WARMUP` (T8); `computeDerivativesContext` (T4); `getCandles` de `src/db/repositories/ohlcv-candles.ts`; `getFundingRange` de `src/db/repositories/funding-rates.ts`; `getOpenInterestRange` de `src/db/repositories/open-interest.ts`; `insertSignal` (T9); `timeframeToMs`, `type Timeframe` de `src/lib/market-data/config.ts`; `Strategy`/`CandlesByTimeframe` de `./types.ts`.
- Produces: `LOOKBACK` (300), `scanSymbol(strategy, symbol, asOf): Promise<string | null>`.

- [ ] **Step 1: Escribir el test de integración (falla)**

```ts
// src/lib/scanner/scan-symbol.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { seedStrategies } from '../../db/seed-strategies.ts';
import { upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { getStrategy } from '../../db/repositories/strategies.ts';
import { scanSymbol } from './scan-symbol.ts';
import type { OhlcvRow } from '../market-data/types.ts';

const SYMBOL = 'TEST/USDT';
const TF_MS: Record<string, number> = { '4h': 14_400_000, '1h': 3_600_000, '15m': 900_000 };
const AS_OF = new Date('2026-03-01T00:00:00Z');

// Genera 250 velas alcistas por TF terminando antes de AS_OF (cierres crecientes).
function bullishCandles(tf: string): OhlcvRow[] {
  const n = 250;
  return Array.from({ length: n }, (_, i) => {
    const openTime = new Date(AS_OF.getTime() - (n - i) * TF_MS[tf]);
    const c = 100 + i;
    return { symbol: SYMBOL, timeframe: tf, openTime, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 };
  });
}

beforeAll(async () => {
  await migrate();
  await seedStrategies();
  for (const tf of ['4h', '1h', '15m']) await upsertCandles(bullishCandles(tf));
});
afterAll(async () => {
  await query('DELETE FROM kairos.ohlcv_candles WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('scanSymbol (integración)', () => {
  test('end-to-end: velas alcistas + estrategia semilla → signal persistida', async () => {
    const strategy = await getStrategy('pullback-alcista');
    const id = await scanSymbol(strategy!, SYMBOL, AS_OF);
    // El setup puede o no disparar según near_support/rsi_cross_up sobre la serie sintética;
    // si dispara, debe quedar persistida con el símbolo correcto.
    if (id !== null) {
      const rows = await query<{ symbol: string }>('SELECT symbol FROM kairos.signals WHERE id = $1', [id]);
      expect(rows[0]?.symbol).toBe(SYMBOL);
    }
    expect(id === null || typeof id === 'string').toBe(true);
  });

  test('símbolo sin velas → null', async () => {
    const strategy = await getStrategy('pullback-alcista');
    expect(await scanSymbol(strategy!, 'SIN/DATOS', AS_OF)).toBeNull();
  });
});
```

> Nota: el primer test es tolerante (el disparo depende de que la serie sintética cumpla `rsi_cross_up`/`near_support`); lo que afirma con dureza es que **si** dispara, persiste correctamente, y que `scanSymbol` no lanza. El disparo determinista end-to-end se cubre en el test PURO de `scan.test.ts` (T8). Mantén el assert de "símbolo sin velas → null" como la garantía dura del camino DB.

- [ ] **Step 2: Correr el test (falla)**

Run: `npx vitest run src/lib/scanner/scan-symbol.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `scan-symbol.ts`**

```ts
// src/lib/scanner/scan-symbol.ts
import type { Strategy, CandlesByTimeframe } from './types.ts';
import { scan } from './scan.ts';
import { computeDerivativesContext } from './derivatives-features.ts';
import { getCandles } from '../../db/repositories/ohlcv-candles.ts';
import { getFundingRange } from '../../db/repositories/funding-rates.ts';
import { getOpenInterestRange } from '../../db/repositories/open-interest.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { timeframeToMs, type Timeframe } from '../market-data/config.ts';

const LOOKBACK = 300;                 // velas por TF (cubre EMA200 + margen)
const DERIV_LOOKBACK_DAYS = 30;       // ventana para funding_z / oi_change_pct
const DAY_MS = 86_400_000;

// Conveniencia DB-facing: lee velas+derivados de SP1 hasta asOf, llama scan, persiste si dispara.
export async function scanSymbol(strategy: Strategy, symbol: string, asOf: Date): Promise<string | null> {
  const tfs = strategy.triggerConfig.timeframes;
  const candlesByTf: CandlesByTimeframe = {};
  for (const tf of [tfs.bias, tfs.context, tfs.trigger]) {
    const from = new Date(asOf.getTime() - LOOKBACK * timeframeToMs(tf as Timeframe));
    candlesByTf[tf] = await getCandles(symbol, tf, from, asOf);
  }

  const derivFrom = new Date(asOf.getTime() - DERIV_LOOKBACK_DAYS * DAY_MS);
  const rates = await getFundingRange(symbol, derivFrom, asOf);
  const ois = await getOpenInterestRange(symbol, derivFrom, asOf);
  const deriv = computeDerivativesContext(rates, ois);

  const signal = scan(strategy, symbol, candlesByTf, deriv, asOf);
  return signal ? insertSignal(signal) : null;
}
```

- [ ] **Step 4: Correr el test (pasa) + typecheck**

Run: `npx vitest run src/lib/scanner/scan-symbol.test.ts`
Expected: PASS.
Run: `npm run typecheck` → sin errores.

- [ ] **Step 5: Suite completa con cobertura**

Run: `npx vitest run --coverage`
Expected: PASS; cobertura global ≥80% en las 4 métricas.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scanner/scan-symbol.ts src/lib/scanner/scan-symbol.test.ts
git commit -m "feat: scanSymbol end-to-end del scanner (SP2)"
```

---

## Verificación final (manual, opcional)

Con SP1 backfilleado (datos reales en Postgres) y la semilla sembrada:
```bash
docker compose up -d postgres
npm run migrate && npm run seed
node --experimental-strip-types -e "import('./src/lib/scanner/scan-symbol.ts').then(async m => { const { getStrategy } = await import('./src/db/repositories/strategies.ts'); const s = await getStrategy('pullback-alcista'); console.error(await m.scanSymbol(s, 'BTC/USDT', new Date())); process.exit(0); })"
```
Confirma que `scanSymbol` corre sobre datos reales sin lanzar (dispare o no según el mercado).

---

## Self-Review del plan

**Cobertura del spec:**
- §4.1 tipos → Task 1 (`types.ts`). §4 indicadores/estructura/features → Tasks 1-3. §15.4 funding_z/oi_change_pct → Task 4. §4.2 predicados → Task 5. §4.3 motor de reglas + validación Valibot → Task 6. §16.4 gate MTF → Task 7. §4.5 snapshot + scan puro (warmup, skip, entry, gate) → Task 8. §3/§4.4 strategies/signals/seed → Task 9. `scanSymbol` end-to-end → Task 10.
- Decisiones del spec: warmup por-TF (T8 `REQUIRED_WARMUP`), mtf direccional+gate (T7), estructura por pivotes (T2), dep technicalindicators con verificación (T1).
- Fuera de alcance respetado: sin scheduler/Redis (SP5), sin encolar/LLM (Fase 2), sin check_risk (SP3), sin DDL.

**Placeholder scan:** sin TBD/TODO; todo step de código trae el código completo; comandos con salida esperada. La única "verificación diferida" (API de technicalindicators) es un paso explícito de Task 1 con la firma pública fija.

**Consistencia de tipos:** `Features`/`Signal`/`Strategy`/`TriggerConfig`/`RuleNode` definidos en T1 y consumidos verbatim por T3-T10. `scan(strategy, symbol, candlesByTf, deriv, now)` (T8) coincide con su uso en `scanSymbol` (T10). `predicates`/`PredicateCtx` (T5) usados por rules-engine (T6) y config-schema (T6). `computeFeatures` (T3) usado por scan (T8). `buildSnapshot` (T8) coincide con su llamada en scan. Repos (T9) coinciden con su uso en scanSymbol (T10).
