# SP4 — Backtester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir un backtester determinista que reproduce el code path de SP1–SP3 barra a barra sobre histórico, con contabilidad en memoria, anti look-ahead estricto, métricas comprensivas (§20.3) y persistencia en `backtest_runs`.

**Architecture:** Un driver de replay (`src/lib/backtest/`) ensambla las funciones **puras** ya existentes (`scan`, `buildDeterministicVerdict`, `evaluateRisk`, `simulateFill`, `resolveBracket`) sin tocar `executeOrderSim`/repos de dominio. La contabilidad (equity, posición, racha, dailyPnl, drawdown) vive en un `Ledger` inmutable en memoria; solo se persiste el agregado (`backtest_runs`). Single-símbolo, una posición a la vez, ventana única.

**Tech Stack:** TypeScript (Node ≥22.19, `--experimental-strip-types`), Postgres (`pg`), Valibot, Vitest. Sin dependencias nuevas.

## Global Constraints

- **Líneas rojas (CLAUDE.md):** ninguna tool de mutación en `tools:[]` de ningún agente — N/A aquí (SP4 es código determinista puro). El backtester **no** usa `executeOrderSim` ni escribe a `positions/orders/fills`; solo lee histórico y escribe `backtest_runs`.
- **Reuso obligatorio (no reimplementar):** `scan`, `REQUIRED_WARMUP` (`src/lib/scanner/scan.ts`); `buildDeterministicVerdict` (`src/lib/execution/verdict.ts`); `evaluateRisk`, `GatheredState` (`src/lib/execution/check-risk.ts`); `computeSize` (vía `evaluateRisk`); `simulateFill` (`src/lib/execution/fill.ts`); `resolveBracket` (`src/lib/execution/bracket.ts`); `parseRiskParams`, `SimParams`, `BracketResolution`, `PositionForResolve`, `BarOHLC` (`src/lib/execution/types.ts`); `DEFAULT_SIM_PARAMS`, `DEFAULT_SIM_STARTING_EQUITY` (`src/lib/execution/limits.ts`); `getCandles` (`src/db/repositories/ohlcv-candles.ts`); `getFundingRange` (`src/db/repositories/funding-rates.ts`); `getOpenInterestRange` (`src/db/repositories/open-interest.ts`); `computeDerivativesContext` (`src/lib/scanner/derivatives-features.ts`); `getStrategy` (`src/db/repositories/strategies.ts`); `timeframeToMs`, `TIMEFRAMES`, `Timeframe` (`src/lib/market-data/config.ts`).
- **Anti look-ahead (§20.2):** velas solo con cierre `open_time + tfMs ≤ T`; fill al `open` de la barra siguiente; SL primero (ya en `resolveBracket`); fees+slippage siempre.
- **Paridad con live:** `closedCandlesAt` entrega las **últimas `LOOKBACK = 300` velas cerradas** por TF (igual que `scanSymbol`), no toda la historia — mismos indicadores que en vivo y O(n·LOOKBACK), no O(n²).
- **Estilo:** funciones <50 líneas, archivos <800, sin anidamiento >4, inmutabilidad por defecto, validación en los límites, **sin `console.log` de debug** (el CLI usa `console.log` para el reporte: permitido, es salida de usuario), sin secretos.
- **Tests:** `npm test` (vitest run). Símbolo **dedicado por archivo** de test de integración (lección del flaky de SP2). Objetivo cobertura ≥80%.
- **Modo:** `mode='det'` siempre en SP4 (LLM OFF). Long-only.

## Notas de realidad del codebase (verificadas, no de memoria)

- La tabla `kairos.backtest_runs` **ya existe** en `src/db/schema.sql` con `("window" tstzrange, mode CHECK('det','llm'), sim_params jsonb, metrics jsonb)` — **sin** `symbol` ni `trades`. Task 1 las añade (CREATE extendido + `ALTER … ADD COLUMN IF NOT EXISTS` idempotente). El spec §4 (que describía `window_from/to` y "nueva migración") se ajusta a esta realidad: `window` es un `tstzrange` y el cambio es sobre `schema.sql`, no una migración numerada.
- `numeric` de pg llega como **string** → convertir con `Number()`. `jsonb` llega ya **parseado** (objeto).
- Migración: `npm run migrate` aplica `schema.sql` entero (idempotente).

---

## File Structure

| Archivo | Responsabilidad | Task |
|---|---|---|
| `src/db/schema.sql` (MODIFY) | Añade `symbol`/`trades` a `backtest_runs` | 1 |
| `src/db/repositories/backtest-runs.ts` | `insertBacktestRun` / `getBacktestRun` | 1 |
| `src/db/repositories/backtest-runs.test.ts` | Test integración del repo | 1 |
| `src/lib/backtest/types.ts` | Tipos compartidos del módulo | 2 |
| `src/lib/backtest/accounting.ts` | `Ledger` inmutable + `GatheredState` en memoria | 2 |
| `src/lib/backtest/accounting.test.ts` | Tests puros de contabilidad | 2 |
| `src/lib/backtest/metrics.ts` | Reporte comprensivo §20.3 (puro) | 3 |
| `src/lib/backtest/metrics.test.ts` | Tests puros de métricas | 3 |
| `src/lib/backtest/data-source.ts` | Carga point-in-time + ventana deslizante | 4 |
| `src/lib/backtest/data-source.test.ts` | Test integración point-in-time | 4 |
| `src/lib/backtest/replay-driver.ts` | Loop barra a barra (ensambla puras) | 5 |
| `src/lib/backtest/replay-driver.test.ts` | Tests del driver (fill-a-barra, SL-primero, eod) | 5 |
| `src/lib/backtest/run-backtest.ts` | Orquestación + persistencia | 6 |
| `src/lib/backtest/run-backtest.test.ts` | Test integración end-to-end + reproducibilidad | 6 |
| `src/cli/backtest.ts` (CREATE) + `package.json` (MODIFY) | CLI delgado | 7 |

---

## Task 1: Schema + repo `backtest-runs`

**Files:**
- Modify: `src/db/schema.sql` (bloque `backtest_runs`, líneas ~172-182)
- Create: `src/db/repositories/backtest-runs.ts`
- Test: `src/db/repositories/backtest-runs.test.ts`

**Interfaces:**
- Consumes: `query`, `pool` de `src/db/pool.ts`; `ulid` de `ulidx`; `migrate` de `src/db/migrate.ts`; `SimParams` de `src/lib/execution/types.ts`; los tipos `Window`, `BacktestMetrics`, `ClosedTrade` aún no existen → este task los importa desde `src/lib/backtest/types.ts` declarándolos mínimos **inline** como `unknown`-safe: para evitar acoplar Task 1 a Task 2, el repo tipa `metrics`/`trades` como genéricos serializables (`Record<string, unknown>` / `unknown[]`). Task 6 pasa los tipos reales (compatibles).
- Produces:
  - `insertBacktestRun(p: InsertBacktestRunInput): Promise<string>` (devuelve el `id` ulid)
  - `getBacktestRun(id: string): Promise<BacktestRunRow | null>`
  - `interface InsertBacktestRunInput { strategyId: string; strategyVersion: number; symbol: string; window: { from: Date; to: Date }; mode: 'det' | 'llm'; simParams: SimParams; metrics: Record<string, unknown>; trades: unknown[]; }`
  - `interface BacktestRunRow { id: string; strategyId: string; strategyVersion: number; symbol: string; mode: string; metrics: Record<string, unknown>; trades: unknown[]; }`

- [ ] **Step 1: Verificar firmas reales (no de memoria)**

Abrir y confirmar firmas exactas (esta task y las siguientes dependen de ellas):
`src/db/repositories/open-interest.ts` → confirmar `getOpenInterestRange(symbol: string, from: Date, to: Date): Promise<OpenInterestRow[]>`. Confirmar también `src/db/pool.ts` exporta `query` y `pool`, y `src/lib/execution/limits.ts` exporta `DEFAULT_SIM_PARAMS` y `DEFAULT_SIM_STARTING_EQUITY`. Si alguna difiere, ajustar los imports de los tasks afectados.

- [ ] **Step 2: Extender el schema**

En `src/db/schema.sql`, reemplazar el bloque `CREATE TABLE IF NOT EXISTS kairos.backtest_runs (...)` por:

```sql
-- Resultado reproducible de un backtest (§20). symbol/trades añadidos en SP4.
CREATE TABLE IF NOT EXISTS kairos.backtest_runs (
  id               text PRIMARY KEY,
  strategy_id      text NOT NULL REFERENCES kairos.strategies(id),
  strategy_version integer NOT NULL,
  symbol           text,
  "window"         tstzrange,
  mode             text NOT NULL CHECK (mode IN ('det', 'llm')),
  sim_params       jsonb NOT NULL,
  metrics          jsonb NOT NULL,
  trades           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Idempotente para DBs migradas antes de SP4 (CREATE IF NOT EXISTS no altera columnas existentes).
ALTER TABLE kairos.backtest_runs ADD COLUMN IF NOT EXISTS symbol text;
ALTER TABLE kairos.backtest_runs ADD COLUMN IF NOT EXISTS trades jsonb NOT NULL DEFAULT '[]'::jsonb;
```

- [ ] **Step 3: Escribir el test (failing)**

`src/db/repositories/backtest-runs.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertBacktestRun, getBacktestRun } from './backtest-runs.ts';

const STRATEGY_ID = 'bt-runs-test-strategy';
const SYMBOL = 'BTRUNS/USDT';

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 3) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
});
afterAll(async () => {
  await query(`DELETE FROM kairos.backtest_runs WHERE strategy_id = $1`, [STRATEGY_ID]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('backtest-runs repo', () => {
  test('insertBacktestRun persiste y getBacktestRun recupera métricas y trades', async () => {
    const id = await insertBacktestRun({
      strategyId: STRATEGY_ID, strategyVersion: 3, symbol: SYMBOL,
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-02-01T00:00:00Z') },
      mode: 'det',
      simParams: { spread_bps: 4, slippage_bps: 5, fee_bps: 10 },
      metrics: { totalReturnPct: 12.5, trades: 3 },
      trades: [{ realizedPnl: 10, hitType: 'tp' }],
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ulid
    const row = await getBacktestRun(id);
    expect(row).not.toBeNull();
    expect(row!.symbol).toBe(SYMBOL);
    expect(row!.mode).toBe('det');
    expect(row!.metrics.totalReturnPct).toBe(12.5);
    expect(row!.trades).toHaveLength(1);
  });

  test('getBacktestRun devuelve null para id inexistente', async () => {
    expect(await getBacktestRun('00000000000000000000000000')).toBeNull();
  });
});
```

- [ ] **Step 4: Run test → FAIL**

Run: `npx vitest run src/db/repositories/backtest-runs.test.ts`
Expected: FAIL ("Cannot find module './backtest-runs.ts'" o export inexistente).

- [ ] **Step 5: Implementar el repo**

`src/db/repositories/backtest-runs.ts`:

```ts
import { ulid } from 'ulidx';
import { query } from '../pool.ts';
import type { SimParams } from '../../lib/execution/types.ts';

export interface InsertBacktestRunInput {
  strategyId: string;
  strategyVersion: number;
  symbol: string;
  window: { from: Date; to: Date };
  mode: 'det' | 'llm';
  simParams: SimParams;
  metrics: Record<string, unknown>;
  trades: unknown[];
}

export async function insertBacktestRun(p: InsertBacktestRunInput): Promise<string> {
  const id = ulid();
  await query(
    `INSERT INTO kairos.backtest_runs
       (id, strategy_id, strategy_version, symbol, "window", mode, sim_params, metrics, trades)
     VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[]'), $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
    [id, p.strategyId, p.strategyVersion, p.symbol, p.window.from, p.window.to, p.mode,
     JSON.stringify(p.simParams), JSON.stringify(p.metrics), JSON.stringify(p.trades)],
  );
  return id;
}

export interface BacktestRunRow {
  id: string;
  strategyId: string;
  strategyVersion: number;
  symbol: string;
  mode: string;
  metrics: Record<string, unknown>;
  trades: unknown[];
}

export async function getBacktestRun(id: string): Promise<BacktestRunRow | null> {
  const rows = await query<{
    id: string; strategy_id: string; strategy_version: number;
    symbol: string; mode: string; metrics: Record<string, unknown>; trades: unknown[];
  }>(
    `SELECT id, strategy_id, strategy_version, symbol, mode, metrics, trades
       FROM kairos.backtest_runs WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r
    ? { id: r.id, strategyId: r.strategy_id, strategyVersion: r.strategy_version,
        symbol: r.symbol, mode: r.mode, metrics: r.metrics, trades: r.trades }
    : null;
}
```

- [ ] **Step 6: Run test → PASS**

Run: `npx vitest run src/db/repositories/backtest-runs.test.ts`
Expected: PASS (2 tests). Requiere Postgres con `DATABASE_URL` (mismo que SP1–SP3).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: sin errores.

```bash
git add src/db/schema.sql src/db/repositories/backtest-runs.ts src/db/repositories/backtest-runs.test.ts
git commit -m "feat: tabla backtest_runs (symbol/trades) y repo (SP4)"
```

---

## Task 2: `accounting.ts` — contabilidad en memoria

**Files:**
- Create: `src/lib/backtest/types.ts`
- Create: `src/lib/backtest/accounting.ts`
- Test: `src/lib/backtest/accounting.test.ts`

**Interfaces:**
- Consumes: `GatheredState` de `src/lib/execution/check-risk.ts`; `BracketResolution` de `src/lib/execution/types.ts`.
- Produces (en `types.ts`):
  - `interface Window { from: Date; to: Date }`
  - `interface OpenPosition { entry: number; size: number; sl: number; tp: number; entryFee: number; openedAt: Date }`
  - `interface ClosedTrade { openedAt: Date; closedAt: Date; entry: number; exit: number; size: number; fees: number; realizedPnl: number; hitType: 'sl' | 'tp' | 'eod'; rMultiple: number }`
  - `interface EquityPoint { t: Date; equity: number }`
  - `interface Ledger { startingEquity: number; realized: number; peakEquity: number; open: OpenPosition | null; trades: readonly ClosedTrade[] }`
  - `interface TradeClose { hitType: 'sl' | 'tp' | 'eod'; exitPrice: number; exitFee: number; realizedPnl: number }`
- Produces (en `accounting.ts`):
  - `emptyLedger(startingEquity: number): Ledger`
  - `markToMarket(l: Ledger, markPrice: number): number`
  - `markEquity(l: Ledger, markPrice: number): Ledger`
  - `applyOpen(l: Ledger, pos: OpenPosition): Ledger`
  - `applyClose(l: Ledger, close: TradeClose, openedAt: Date, closedAt: Date): Ledger`
  - `gatherState(l: Ledger, T: Date, markPrice: number): GatheredState`

- [ ] **Step 1: Crear `types.ts`**

`src/lib/backtest/types.ts`:

```ts
import type { Verdict, SimParams } from '../execution/types.ts';

export interface Window { from: Date; to: Date; }

export interface OpenPosition {
  entry: number; size: number; sl: number; tp: number; entryFee: number; openedAt: Date;
}

export interface ClosedTrade {
  openedAt: Date; closedAt: Date; entry: number; exit: number; size: number;
  fees: number; realizedPnl: number; hitType: 'sl' | 'tp' | 'eod'; rMultiple: number;
}

export interface EquityPoint { t: Date; equity: number; }

export interface Ledger {
  startingEquity: number;
  realized: number;
  peakEquity: number;
  open: OpenPosition | null;
  trades: readonly ClosedTrade[];
}

export interface TradeClose {
  hitType: 'sl' | 'tp' | 'eod'; exitPrice: number; exitFee: number; realizedPnl: number;
}

// Tipos de Task 3 (metrics) y Task 6 (run) — declarados aquí para que todos los módulos compartan.
export interface BacktestMetrics {
  totalReturnPct: number; cagrPct: number; buyHoldReturnPct: number;
  sharpe: number; sortino: number; calmar: number;
  maxDrawdownPct: number; drawdownDurationDays: number; recoveryDays: number | null;
  trades: number; winRate: number; profitFactor: number | null;
  expectancy: number; avgWin: number; avgLoss: number; payoffRatio: number | null;
  exposurePct: number; turnover: number;
}

export interface BacktestConfig {
  strategyId: string; symbol: string; window: Window;
  startingEquity?: number; simParams?: SimParams;
}

export interface BacktestResult {
  runId: string; symbol: string; metrics: BacktestMetrics;
  trades: ClosedTrade[]; equityCurve: EquityPoint[];
}

export interface ReplayOutput {
  trades: ClosedTrade[]; equityCurve: EquityPoint[]; finalLedger: Ledger;
}
```

- [ ] **Step 2: Escribir el test (failing)**

`src/lib/backtest/accounting.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { emptyLedger, markToMarket, markEquity, applyOpen, applyClose, gatherState } from './accounting.ts';
import type { OpenPosition } from './types.ts';

const POS: OpenPosition = { entry: 100, size: 2, sl: 95, tp: 110, entryFee: 0.2, openedAt: new Date('2024-01-01T00:00:00Z') };

describe('accounting', () => {
  test('emptyLedger arranca plano', () => {
    const l = emptyLedger(10000);
    expect(l.realized).toBe(0);
    expect(l.peakEquity).toBe(10000);
    expect(l.open).toBeNull();
  });

  test('markToMarket suma el no-realizado de la posición abierta (sin fee de salida)', () => {
    const l = applyOpen(emptyLedger(10000), POS);
    // unrealized = (105-100)*2 - 0.2 = 9.8
    expect(markToMarket(l, 105)).toBeCloseTo(10009.8, 6);
  });

  test('markEquity sube el high-water mark, nunca baja', () => {
    let l = applyOpen(emptyLedger(10000), POS);
    l = markEquity(l, 105);          // mtm 10009.8 → peak sube
    expect(l.peakEquity).toBeCloseTo(10009.8, 6);
    l = markEquity(l, 90);           // mtm baja → peak NO baja
    expect(l.peakEquity).toBeCloseTo(10009.8, 6);
  });

  test('applyClose registra el trade, acumula realized y deja open en null', () => {
    let l = applyOpen(emptyLedger(10000), POS);
    l = applyClose(l, { hitType: 'tp', exitPrice: 110, exitFee: 0.22, realizedPnl: 19.58 }, POS.openedAt, new Date('2024-01-01T05:00:00Z'));
    expect(l.open).toBeNull();
    expect(l.realized).toBeCloseTo(19.58, 6);
    expect(l.trades).toHaveLength(1);
    // rMultiple = realizedPnl / ((entry - sl) * size) = 19.58 / ((100-95)*2) = 1.958
    expect(l.trades[0].rMultiple).toBeCloseTo(1.958, 3);
    expect(l.trades[0].fees).toBeCloseTo(0.42, 6); // entryFee + exitFee
  });

  test('gatherState: dailyPnl solo del día UTC de T, racha de pérdidas, exposición', () => {
    let l = emptyLedger(10000);
    // cierre perdedor el 2024-01-01
    l = applyClose(applyOpen(l, POS), { hitType: 'sl', exitPrice: 95, exitFee: 0.2, realizedPnl: -10.4 }, POS.openedAt, new Date('2024-01-01T03:00:00Z'));
    // cierre perdedor el 2024-01-02
    l = applyClose(applyOpen(l, { ...POS, openedAt: new Date('2024-01-02T00:00:00Z') }), { hitType: 'sl', exitPrice: 95, exitFee: 0.2, realizedPnl: -10.4 }, new Date('2024-01-02T00:00:00Z'), new Date('2024-01-02T03:00:00Z'));
    const s = gatherState(l, new Date('2024-01-02T10:00:00Z'), 100);
    expect(s.dailyPnl).toBeCloseTo(-10.4, 6);     // solo el cierre del 02
    expect(s.consecutiveLosses).toBe(2);          // ambos perdedores, consecutivos
    expect(s.openPositionsCount).toBe(0);
  });

  test('gatherState: el cierre de ayer UTC se excluye del dailyPnl (borde de día)', () => {
    let l = applyClose(applyOpen(emptyLedger(10000), POS), { hitType: 'tp', exitPrice: 110, exitFee: 0.2, realizedPnl: 19.6 }, POS.openedAt, new Date('2024-01-01T23:59:59Z'));
    const s = gatherState(l, new Date('2024-01-02T00:00:01Z'), 100);
    expect(s.dailyPnl).toBe(0);                    // el cierre cayó el 01, T es el 02
  });
});
```

- [ ] **Step 3: Run test → FAIL**

Run: `npx vitest run src/lib/backtest/accounting.test.ts`
Expected: FAIL ("Cannot find module './accounting.ts'").

- [ ] **Step 4: Implementar `accounting.ts`**

`src/lib/backtest/accounting.ts`:

```ts
import type { GatheredState } from '../execution/check-risk.ts';
import type { Ledger, OpenPosition, ClosedTrade, TradeClose } from './types.ts';

export function emptyLedger(startingEquity: number): Ledger {
  return { startingEquity, realized: 0, peakEquity: startingEquity, open: null, trades: [] };
}

function unrealized(open: OpenPosition | null, markPrice: number): number {
  if (!open) return 0;
  return (markPrice - open.entry) * open.size - open.entryFee;
}

export function markToMarket(l: Ledger, markPrice: number): number {
  return l.startingEquity + l.realized + unrealized(l.open, markPrice);
}

export function markEquity(l: Ledger, markPrice: number): Ledger {
  const eq = markToMarket(l, markPrice);
  return eq > l.peakEquity ? { ...l, peakEquity: eq } : l;
}

export function applyOpen(l: Ledger, pos: OpenPosition): Ledger {
  return { ...l, open: pos };
}

export function applyClose(l: Ledger, close: TradeClose, openedAt: Date, closedAt: Date): Ledger {
  if (!l.open) throw new Error('applyClose sin posición abierta');
  const open = l.open;
  const riskPerUnit = open.entry - open.sl;
  const rMultiple = riskPerUnit > 0 ? close.realizedPnl / (riskPerUnit * open.size) : 0;
  const trade: ClosedTrade = {
    openedAt, closedAt, entry: open.entry, exit: close.exitPrice, size: open.size,
    fees: open.entryFee + close.exitFee, realizedPnl: close.realizedPnl, hitType: close.hitType, rMultiple,
  };
  return { ...l, realized: l.realized + close.realizedPnl, open: null, trades: [...l.trades, trade] };
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

export function gatherState(l: Ledger, T: Date, markPrice: number): GatheredState {
  const equity = markToMarket(l, markPrice);
  const drawdownPct = l.peakEquity > 0 ? Math.max(0, ((l.peakEquity - equity) / l.peakEquity) * 100) : 0;
  const dailyPnl = l.trades
    .filter((t) => sameUtcDay(t.closedAt, T))
    .reduce((a, t) => a + t.realizedPnl, 0);
  let consecutiveLosses = 0;
  for (let i = l.trades.length - 1; i >= 0; i--) {
    if (l.trades[i].realizedPnl < 0) consecutiveLosses++;
    else break;
  }
  const notional = l.open ? l.open.entry * l.open.size : 0;
  return {
    equity, drawdownPct, dailyPnl,
    openNotionalTotal: notional, openNotionalSymbol: notional,
    openPositionsCount: l.open ? 1 : 0, consecutiveLosses,
  };
}
```

- [ ] **Step 5: Run test → PASS**

Run: `npx vitest run src/lib/backtest/accounting.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/lib/backtest/types.ts src/lib/backtest/accounting.ts src/lib/backtest/accounting.test.ts
git commit -m "feat: contabilidad en memoria del backtester (Ledger inmutable) (SP4)"
```

---

## Task 3: `metrics.ts` — reporte comprensivo (§20.3)

**Files:**
- Create: `src/lib/backtest/metrics.ts`
- Test: `src/lib/backtest/metrics.test.ts`

**Interfaces:**
- Consumes: `ClosedTrade`, `EquityPoint`, `BacktestMetrics`, `Window` de `./types.ts`.
- Produces:
  - `interface MetricsInput { trades: readonly ClosedTrade[]; equityCurve: readonly EquityPoint[]; startingEquity: number; buyHold: { entryPrice: number; exitPrice: number }; window: Window }`
  - `computeMetrics(input: MetricsInput): BacktestMetrics`

- [ ] **Step 1: Escribir el test (failing)**

`src/lib/backtest/metrics.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { computeMetrics } from './metrics.ts';
import type { ClosedTrade, EquityPoint } from './types.ts';

const WIN: ClosedTrade = { openedAt: new Date('2024-01-01T00:00:00Z'), closedAt: new Date('2024-01-01T06:00:00Z'), entry: 100, exit: 110, size: 1, fees: 0.2, realizedPnl: 20, hitType: 'tp', rMultiple: 2 };
const LOSS: ClosedTrade = { openedAt: new Date('2024-01-02T00:00:00Z'), closedAt: new Date('2024-01-02T06:00:00Z'), entry: 100, exit: 95, size: 1, fees: 0.2, realizedPnl: -10, hitType: 'sl', rMultiple: -1 };

function curve(values: Array<[string, number]>): EquityPoint[] {
  return values.map(([t, equity]) => ({ t: new Date(t), equity }));
}

describe('computeMetrics', () => {
  test('trade stats: winRate, profitFactor, expectancy, payoff', () => {
    const m = computeMetrics({
      trades: [WIN, LOSS], startingEquity: 10000,
      equityCurve: curve([['2024-01-01T06:00:00Z', 10020], ['2024-01-02T06:00:00Z', 10010]]),
      buyHold: { entryPrice: 100, exitPrice: 105 },
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-03T00:00:00Z') },
    });
    expect(m.trades).toBe(2);
    expect(m.winRate).toBeCloseTo(50, 6);
    expect(m.profitFactor).toBeCloseTo(2, 6);       // 20 / 10
    expect(m.expectancy).toBeCloseTo(5, 6);          // (20 - 10) / 2
    expect(m.avgWin).toBeCloseTo(20, 6);
    expect(m.avgLoss).toBeCloseTo(-10, 6);
    expect(m.payoffRatio).toBeCloseTo(2, 6);         // 20 / 10
    expect(m.buyHoldReturnPct).toBeCloseTo(5, 6);    // (105-100)/100
  });

  test('caso sin trades: stats neutros, sin NaN', () => {
    const m = computeMetrics({
      trades: [], startingEquity: 10000,
      equityCurve: curve([['2024-01-01T00:00:00Z', 10000], ['2024-01-02T00:00:00Z', 10000]]),
      buyHold: { entryPrice: 100, exitPrice: 100 },
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-02T00:00:00Z') },
    });
    expect(m.trades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.profitFactor).toBeNull();
    expect(m.payoffRatio).toBeNull();
    expect(Number.isNaN(m.sharpe)).toBe(false);
    expect(m.maxDrawdownPct).toBe(0);
  });

  test('maxDrawdown sobre la curva de equity', () => {
    const m = computeMetrics({
      trades: [], startingEquity: 100,
      equityCurve: curve([
        ['2024-01-01T00:00:00Z', 100], ['2024-01-02T00:00:00Z', 120],
        ['2024-01-03T00:00:00Z', 90], ['2024-01-04T00:00:00Z', 130],
      ]),
      buyHold: { entryPrice: 1, exitPrice: 1 },
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-04T00:00:00Z') },
    });
    // pico 120 → valle 90 → DD = (120-90)/120 = 25%
    expect(m.maxDrawdownPct).toBeCloseTo(25, 6);
  });
});
```

- [ ] **Step 2: Run test → FAIL**

Run: `npx vitest run src/lib/backtest/metrics.test.ts`
Expected: FAIL ("Cannot find module './metrics.ts'").

- [ ] **Step 3: Implementar `metrics.ts`**

`src/lib/backtest/metrics.ts`:

```ts
import type { ClosedTrade, EquityPoint, BacktestMetrics, Window } from './types.ts';

const DAY_MS = 86_400_000;
const ANNUALIZATION = 365; // cripto opera 24/7

export interface MetricsInput {
  trades: readonly ClosedTrade[];
  equityCurve: readonly EquityPoint[];
  startingEquity: number;
  buyHold: { entryPrice: number; exitPrice: number };
  window: Window;
}

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

// Equity al último punto de cada día UTC → retornos diarios.
function dailyReturns(curve: readonly EquityPoint[]): number[] {
  const lastByDay = new Map<string, number>();
  for (const p of curve) lastByDay.set(utcDayKey(p.t), p.equity);
  const equities = [...lastByDay.values()];
  const returns: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    if (equities[i - 1] !== 0) returns.push(equities[i] / equities[i - 1] - 1);
  }
  return returns;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function downsideStd(xs: readonly number[]): number {
  const neg = xs.filter((x) => x < 0);
  if (neg.length === 0) return 0;
  return Math.sqrt(neg.reduce((a, b) => a + b ** 2, 0) / xs.length);
}

interface DrawdownStats { maxDrawdownPct: number; drawdownDurationDays: number; recoveryDays: number | null; }

function drawdownStats(curve: readonly EquityPoint[]): DrawdownStats {
  let peak = curve.length ? curve[0].equity : 0;
  let peakT = curve.length ? curve[0].t : new Date(0);
  let maxDd = 0;
  let troughT = peakT;
  let ddPeakT = peakT;
  let recovered = true;
  let recoveryMs: number | null = null;
  for (const p of curve) {
    if (p.equity > peak) {
      if (!recovered && troughT) recoveryMs = p.t.getTime() - troughT.getTime();
      peak = p.equity; peakT = p.t; recovered = true;
    } else {
      const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
      if (dd > maxDd) { maxDd = dd; troughT = p.t; ddPeakT = peakT; recovered = false; }
    }
  }
  const durationDays = maxDd > 0 ? (troughT.getTime() - ddPeakT.getTime()) / DAY_MS : 0;
  return { maxDrawdownPct: maxDd, drawdownDurationDays: durationDays, recoveryDays: recoveryMs === null ? null : recoveryMs / DAY_MS };
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const { trades, equityCurve, startingEquity, buyHold, window } = input;
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingEquity;
  const totalReturnPct = startingEquity > 0 ? ((finalEquity - startingEquity) / startingEquity) * 100 : 0;

  const days = Math.max((window.to.getTime() - window.from.getTime()) / DAY_MS, 1 / 24);
  const years = days / ANNUALIZATION;
  const growth = startingEquity > 0 ? finalEquity / startingEquity : 1;
  const cagrPct = growth > 0 && years > 0 ? (growth ** (1 / years) - 1) * 100 : 0;

  const buyHoldReturnPct = buyHold.entryPrice > 0 ? ((buyHold.exitPrice - buyHold.entryPrice) / buyHold.entryPrice) * 100 : 0;

  const r = dailyReturns(equityCurve);
  const sd = std(r);
  const dsd = downsideStd(r);
  const sharpe = sd > 0 ? (mean(r) / sd) * Math.sqrt(ANNUALIZATION) : 0;
  const sortino = dsd > 0 ? (mean(r) / dsd) * Math.sqrt(ANNUALIZATION) : 0;

  const dd = drawdownStats(equityCurve);
  const calmar = dd.maxDrawdownPct > 0 ? cagrPct / dd.maxDrawdownPct : 0;

  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;
  const expectancy = trades.length ? trades.reduce((a, t) => a + t.realizedPnl, 0) / trades.length : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const payoffRatio = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null;

  const heldMs = trades.reduce((a, t) => a + (t.closedAt.getTime() - t.openedAt.getTime()), 0);
  const windowMs = Math.max(window.to.getTime() - window.from.getTime(), 1);
  const exposurePct = Math.min(100, (heldMs / windowMs) * 100);
  const turnover = startingEquity > 0 ? trades.reduce((a, t) => a + t.entry * t.size, 0) / startingEquity : 0;

  return {
    totalReturnPct, cagrPct, buyHoldReturnPct,
    sharpe, sortino, calmar,
    maxDrawdownPct: dd.maxDrawdownPct, drawdownDurationDays: dd.drawdownDurationDays, recoveryDays: dd.recoveryDays,
    trades: trades.length, winRate, profitFactor, expectancy, avgWin, avgLoss, payoffRatio,
    exposurePct, turnover,
  };
}
```

- [ ] **Step 4: Run test → PASS**

Run: `npx vitest run src/lib/backtest/metrics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/lib/backtest/metrics.ts src/lib/backtest/metrics.test.ts
git commit -m "feat: métricas comprensivas del backtester (§20.3) (SP4)"
```

---

## Task 4: `data-source.ts` — carga point-in-time + ventana deslizante

**Files:**
- Create: `src/lib/backtest/data-source.ts`
- Test: `src/lib/backtest/data-source.test.ts`

**Interfaces:**
- Consumes: `getCandles` (`ohlcv-candles.ts`), `getFundingRange` (`funding-rates.ts`), `getOpenInterestRange` (`open-interest.ts`), `computeDerivativesContext` (`derivatives-features.ts`), `timeframeToMs`/`TIMEFRAMES`/`Timeframe` (`config.ts`); `Candle`/`CandlesByTimeframe`/`DerivativesContext`/`Strategy` (`scanner/types.ts`); `Window` (`./types.ts`).
- Produces:
  - `const LOOKBACK = 300`
  - `interface BacktestDataSource { triggerCandles: readonly Candle[]; closeTimeAt(i: number): Date; closedCandlesAt(i: number): CandlesByTimeframe; derivativesAt(T: Date): DerivativesContext }`
  - `loadDataSource(strategy: Strategy, symbol: string, window: Window): Promise<BacktestDataSource>`

- [ ] **Step 1: Escribir el test (failing)**

`src/lib/backtest/data-source.test.ts`. Siembra velas en 3 TFs con un símbolo dedicado y verifica point-in-time:

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { loadDataSource, LOOKBACK } from './data-source.ts';
import type { Strategy } from '../scanner/types.ts';
import type { OhlcvRow } from '../market-data/types.ts';

const SYMBOL = 'DSRC/USDT';
const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const STRATEGY: Strategy = {
  id: 'dsrc-strategy', enabled: true, symbols: [SYMBOL],
  triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } },
  riskParams: {}, version: 1, skillName: null,
};

// Genera `n` velas consecutivas de un TF terminando justo antes de `endExclusive`.
function gen(tf: string, startMs: number, n: number): OhlcvRow[] {
  return Array.from({ length: n }, (_, k) => {
    const openTime = new Date(startMs + k * TF_MS[tf]);
    return { symbol: SYMBOL, timeframe: tf, openTime, o: 100, h: 101, l: 99, c: 100, v: 1 };
  });
}

const WINDOW_FROM = new Date('2024-02-01T00:00:00Z');
const WINDOW_TO = new Date('2024-02-02T00:00:00Z');

beforeAll(async () => {
  await migrate();
  // pre-roll generoso (> LOOKBACK) por TF + cobertura de la ventana.
  const preMs = (LOOKBACK + 100) ;
  for (const tf of ['15m', '1h', '4h']) {
    const startMs = WINDOW_FROM.getTime() - preMs * TF_MS[tf];
    const total = preMs + Math.ceil((WINDOW_TO.getTime() - WINDOW_FROM.getTime()) / TF_MS[tf]) + 2;
    await upsertCandles(gen(tf, startMs, total));
  }
});
afterAll(async () => {
  await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [SYMBOL]);
  await pool.end();
});

describe('data-source point-in-time', () => {
  test('triggerCandles solo cubre la ventana [from, to]', async () => {
    const ds = await loadDataSource(STRATEGY, SYMBOL, { from: WINDOW_FROM, to: WINDOW_TO });
    expect(ds.triggerCandles.length).toBeGreaterThan(0);
    for (const c of ds.triggerCandles) {
      expect(c.openTime.getTime()).toBeGreaterThanOrEqual(WINDOW_FROM.getTime());
    }
  });

  test('closedCandlesAt nunca expone una vela con cierre > T (anti look-ahead)', async () => {
    const ds = await loadDataSource(STRATEGY, SYMBOL, { from: WINDOW_FROM, to: WINDOW_TO });
    const i = 10;
    const T = ds.closeTimeAt(i).getTime();
    const byTf = ds.closedCandlesAt(i);
    for (const tf of ['15m', '1h', '4h']) {
      for (const c of byTf[tf]) {
        expect(c.openTime.getTime() + TF_MS[tf]).toBeLessThanOrEqual(T);
      }
      expect(byTf[tf].length).toBeLessThanOrEqual(LOOKBACK); // ventana deslizante
    }
    // la última vela trigger cerrada coincide con la barra i (su cierre == T).
    const trig = byTf['15m'];
    expect(trig[trig.length - 1].openTime.getTime() + TF_MS['15m']).toBe(T);
  });
});
```

- [ ] **Step 2: Run test → FAIL**

Run: `npx vitest run src/lib/backtest/data-source.test.ts`
Expected: FAIL ("Cannot find module './data-source.ts'").

- [ ] **Step 3: Implementar `data-source.ts`**

`src/lib/backtest/data-source.ts`:

```ts
import { getCandles } from '../../db/repositories/ohlcv-candles.ts';
import { getFundingRange } from '../../db/repositories/funding-rates.ts';
import { getOpenInterestRange } from '../../db/repositories/open-interest.ts';
import { computeDerivativesContext } from '../scanner/derivatives-features.ts';
import { timeframeToMs, TIMEFRAMES, type Timeframe } from '../market-data/config.ts';
import type { Candle, CandlesByTimeframe, DerivativesContext, Strategy } from '../scanner/types.ts';
import type { Window } from './types.ts';

export const LOOKBACK = 300;          // velas por TF entregadas a scan (paridad con scanSymbol)
const PREROLL_BARS = LOOKBACK + 50;   // historia antes de `from` para satisfacer warmup
const DERIV_LOOKBACK_DAYS = 30;
const DAY_MS = 86_400_000;

function asTimeframe(tf: string): Timeframe {
  if ((TIMEFRAMES as readonly string[]).includes(tf)) return tf as Timeframe;
  throw new Error(`timeframe no soportado por el backtester: ${tf}`);
}

// Último índice con cierre (openTime + tfMs) <= T. Búsqueda binaria (candles ASC). -1 si ninguno.
function lastClosedIndex(candles: readonly Candle[], T: number, tfMs: number): number {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].openTime.getTime() + tfMs <= T) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

export interface BacktestDataSource {
  triggerCandles: readonly Candle[];
  closeTimeAt(i: number): Date;
  closedCandlesAt(i: number): CandlesByTimeframe;
  derivativesAt(T: Date): DerivativesContext;
}

export async function loadDataSource(strategy: Strategy, symbol: string, window: Window): Promise<BacktestDataSource> {
  const tfs = strategy.triggerConfig.timeframes;
  const tfList = [tfs.bias, tfs.context, tfs.trigger];
  const fullByTf: Record<string, Candle[]> = {};
  for (const tf of tfList) {
    const preroll = PREROLL_BARS * timeframeToMs(asTimeframe(tf));
    fullByTf[tf] = await getCandles(symbol, tf, new Date(window.from.getTime() - preroll), window.to);
  }

  const triggerTfMs = timeframeToMs(asTimeframe(tfs.trigger));
  const triggerCandles = fullByTf[tfs.trigger].filter((c) => c.openTime.getTime() >= window.from.getTime());

  const derivFrom = new Date(window.from.getTime() - DERIV_LOOKBACK_DAYS * DAY_MS);
  const rates = await getFundingRange(symbol, derivFrom, window.to);
  const ois = await getOpenInterestRange(symbol, derivFrom, window.to);

  return {
    triggerCandles,
    closeTimeAt(i: number): Date {
      return new Date(triggerCandles[i].openTime.getTime() + triggerTfMs);
    },
    closedCandlesAt(i: number): CandlesByTimeframe {
      const T = triggerCandles[i].openTime.getTime() + triggerTfMs;
      const out: CandlesByTimeframe = {};
      for (const tf of tfList) {
        const tfMs = timeframeToMs(asTimeframe(tf));
        const idx = lastClosedIndex(fullByTf[tf], T, tfMs);
        out[tf] = idx < 0 ? [] : fullByTf[tf].slice(Math.max(0, idx + 1 - LOOKBACK), idx + 1);
      }
      return out;
    },
    derivativesAt(T: Date): DerivativesContext {
      const tMs = T.getTime();
      return computeDerivativesContext(
        rates.filter((x) => x.ts.getTime() <= tMs),
        ois.filter((x) => x.ts.getTime() <= tMs),
      );
    },
  };
}
```

- [ ] **Step 4: Run test → PASS**

Run: `npx vitest run src/lib/backtest/data-source.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/lib/backtest/data-source.ts src/lib/backtest/data-source.test.ts
git commit -m "feat: data-source point-in-time del backtester (ventana deslizante) (SP4)"
```

---

## Task 5: `replay-driver.ts` — loop barra a barra

**Files:**
- Create: `src/lib/backtest/replay-driver.ts`
- Test: `src/lib/backtest/replay-driver.test.ts`

**Interfaces:**
- Consumes: `scan` (`scanner/scan.ts`), `buildDeterministicVerdict` (`execution/verdict.ts`), `evaluateRisk` (`execution/check-risk.ts`), `simulateFill` (`execution/fill.ts`), `resolveBracket` (`execution/bracket.ts`), `parseRiskParams` (`execution/types.ts`); `emptyLedger`/`applyOpen`/`applyClose`/`markEquity`/`markToMarket`/`gatherState` (`./accounting.ts`); `BacktestDataSource` (`./data-source.ts`); `Strategy` (`scanner/types.ts`); `SimParams`/`Verdict` (`execution/types.ts`); `Ledger`/`ReplayOutput`/`EquityPoint` (`./types.ts`).
- Produces:
  - `interface ReplayConfig { startingEquity: number; simParams: SimParams }`
  - `runReplay(strategy: Strategy, symbol: string, ds: BacktestDataSource, cfg: ReplayConfig): ReplayOutput`

> Nota: `markToMarket` debe exportarse desde `accounting.ts` (ya lo hace en Task 2).

- [ ] **Step 1: Escribir el test (failing)**

El test usa un `BacktestDataSource` **falso en memoria** (sin DB). El fake entrega un snapshot bullish fijo de 260 velas por TF (>`REQUIRED_WARMUP`=200) en `closedCandlesAt` para que `scan` **dispare** (emaStack bullish + `entry: { all: [] }` verdadero + `allow_counter: true`), y barras trigger **crafted** que continúan la escala de precios del snapshot para forzar de forma determinista: (a) fill al open de la barra siguiente + SL primero, y (b) cierre end-of-data. Esto cubre los 4 invariantes de §3.3 sin depender de la DB.

`src/lib/backtest/replay-driver.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { runReplay } from './replay-driver.ts';
import type { BacktestDataSource } from './data-source.ts';
import type { Strategy, CandlesByTimeframe, Candle } from '../scanner/types.ts';

const SYMBOL = 'RPL/USDT';
const TRIGGER_MS = 900_000; // 15m
const SIM = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 };
const SNAP_N = 260;                 // > REQUIRED_WARMUP (200)
const B0 = SNAP_N * TRIGGER_MS;     // openTime de la primera barra trigger de ejecución

const STRATEGY: Strategy = {
  id: 'rpl-strategy', enabled: true, symbols: [SYMBOL],
  triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] }, allow_counter: true },
  riskParams: { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 100, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 50, max_drawdown_pct: 90, max_consecutive_losses: 99 },
  version: 1, skillName: null,
};

function bar(openMs: number, o: number, h: number, l: number, c: number): Candle {
  return { symbol: SYMBOL, timeframe: '15m', openTime: new Date(openMs), o, h, l, c, v: 100 };
}

// 260 velas bullish suaves (close 50 → 101.8) → emaStack bullish + ATR>0. Misma serie para los 3 TFs.
function bullish(tf: string): Candle[] {
  return Array.from({ length: SNAP_N }, (_, k) => {
    const c = 50 + k * 0.2;
    return { symbol: SYMBOL, timeframe: tf, openTime: new Date(k * TRIGGER_MS), o: c - 0.1, h: c + 0.4, l: c - 0.4, c, v: 100 };
  });
}
const SCANNABLE: CandlesByTimeframe = { '4h': bullish('4h'), '1h': bullish('1h'), '15m': bullish('15m') };

// closedCandlesAt SIEMPRE devuelve el snapshot bullish → scan dispara cuando no hay posición ni pending.
function signalDs(bars: Candle[]): BacktestDataSource {
  return {
    triggerCandles: bars,
    closeTimeAt: (i) => new Date(bars[i].openTime.getTime() + TRIGGER_MS),
    closedCandlesAt: () => SCANNABLE,
    derivativesAt: () => ({ fundingZ: null, oiChangePct: null }),
  };
}

describe('replay-driver', () => {
  test('sin señales (closedCandlesAt vacío) → 0 trades y equity plana', () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(TRIGGER_MS, 100, 101, 99, 100)];
    const flatDs: BacktestDataSource = {
      triggerCandles: bars,
      closeTimeAt: (i) => new Date(bars[i].openTime.getTime() + TRIGGER_MS),
      closedCandlesAt: () => ({ '4h': [], '1h': [], '15m': [] }),
      derivativesAt: () => ({ fundingZ: null, oiChangePct: null }),
    };
    const out = runReplay(STRATEGY, SYMBOL, flatDs, { startingEquity: 10000, simParams: SIM });
    expect(out.trades).toHaveLength(0);
    expect(out.equityCurve).toHaveLength(2);
    expect(out.equityCurve[0].equity).toBe(10000);
    expect(out.finalLedger.open).toBeNull();
  });

  test('señal en bar0 → entrada al open de bar1 → SL primero (low fuerza el stop)', () => {
    // bar0: dispara señal (verdict ancla ~101.8 del snapshot). bar1: entrada al open=101.8; low=2 ≤ sl.
    const bars = [
      bar(B0, 101.8, 101.85, 101.75, 101.8),
      bar(B0 + TRIGGER_MS, 101.8, 101.85, 2, 50),
    ];
    const out = runReplay(STRATEGY, SYMBOL, signalDs(bars), { startingEquity: 10000, simParams: SIM });
    expect(out.trades).toHaveLength(1);                 // si es 0, el snapshot no disparó scan → ajustar la serie
    expect(out.trades[0].hitType).toBe('sl');
    expect(out.trades[0].entry).toBeGreaterThan(101.8); // fill peor que el open por slippage de compra
    expect(out.trades[0].rMultiple).toBeLessThan(0);
    expect(out.finalLedger.open).toBeNull();
  });

  test('posición abierta al final → cierre end-of-data al último close', () => {
    // bar1 (range estrecho en torno al entry) no toca SL ni TP → queda abierta → eod al close.
    const bars = [
      bar(B0, 101.8, 101.85, 101.75, 101.8),
      bar(B0 + TRIGGER_MS, 101.8, 101.85, 101.75, 101.82),
    ];
    const out = runReplay(STRATEGY, SYMBOL, signalDs(bars), { startingEquity: 10000, simParams: SIM });
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].hitType).toBe('eod');
    expect(out.trades[0].exit).toBeCloseTo(101.82, 6);
  });
});
```

> Los precios de las barras trigger continúan la escala del snapshot (~101.8) para que `sl`/`tp` derivados por `buildDeterministicVerdict` sean coherentes con ellas. Si el test SL reporta 0 trades, el snapshot bullish no disparó `scan`: subir la pendiente o el nº de velas (mismo signo que la guía de Task 6). La reproducibilidad se verifica end-to-end en Task 6.

- [ ] **Step 2: Run test → FAIL**

Run: `npx vitest run src/lib/backtest/replay-driver.test.ts`
Expected: FAIL ("Cannot find module './replay-driver.ts'").

- [ ] **Step 3: Implementar `replay-driver.ts`**

`src/lib/backtest/replay-driver.ts`:

```ts
import { scan } from '../scanner/scan.ts';
import { buildDeterministicVerdict } from '../execution/verdict.ts';
import { evaluateRisk } from '../execution/check-risk.ts';
import { simulateFill } from '../execution/fill.ts';
import { resolveBracket } from '../execution/bracket.ts';
import { parseRiskParams } from '../execution/types.ts';
import { emptyLedger, applyOpen, applyClose, markEquity, markToMarket, gatherState } from './accounting.ts';
import type { BacktestDataSource } from './data-source.ts';
import type { Strategy } from '../scanner/types.ts';
import type { SimParams, Verdict } from '../execution/types.ts';
import type { Ledger, EquityPoint, ReplayOutput } from './types.ts';

export interface ReplayConfig { startingEquity: number; simParams: SimParams; }
interface PendingEntry { verdict: Verdict; size: number; }

export function runReplay(strategy: Strategy, symbol: string, ds: BacktestDataSource, cfg: ReplayConfig): ReplayOutput {
  const rp = parseRiskParams(strategy.riskParams);
  const bars = ds.triggerCandles;
  let ledger: Ledger = emptyLedger(cfg.startingEquity);
  let pending: PendingEntry | null = null;
  const equityCurve: EquityPoint[] = [];

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const T = ds.closeTimeAt(i);

    // 1. Materializar entrada pendiente al open de esta barra.
    if (pending && !ledger.open) {
      const fill = simulateFill('buy', pending.size, b.o, cfg.simParams);
      ledger = applyOpen(ledger, { entry: fill.fillPrice, size: fill.qty, sl: pending.verdict.sl, tp: pending.verdict.tp, entryFee: fill.fee, openedAt: T });
      pending = null;
    }

    // 2. Salida sobre esta barra (SL primero lo garantiza resolveBracket).
    if (ledger.open) {
      const o = ledger.open;
      const res = resolveBracket(
        { entry: o.entry, size: o.size, sl: o.sl, tp: o.tp, entryFee: o.entryFee },
        { open: b.o, high: b.h, low: b.l, close: b.c },
        cfg.simParams,
      );
      if (res) ledger = applyClose(ledger, res, o.openedAt, T);
    }

    // 3. Decisión de entrada (se materializa en la barra siguiente).
    if (!ledger.open && !pending) {
      const signal = scan(strategy, symbol, ds.closedCandlesAt(i), ds.derivativesAt(T), T);
      if (signal) {
        const verdict = buildDeterministicVerdict(signal, strategy);
        if (verdict.action === 'enter') {
          const state = gatherState(ledger, T, b.c);
          const risk = evaluateRisk({ verdict, riskParams: rp, ...state });
          if (risk.result === 'allow' && risk.adjustedSize !== null) {
            pending = { verdict, size: risk.adjustedSize };
          }
        }
      }
    }

    // 4. Marca de equity.
    ledger = markEquity(ledger, b.c);
    equityCurve.push({ t: T, equity: markToMarket(ledger, b.c) });
  }

  // Cierre end-of-data si queda posición abierta.
  if (ledger.open && bars.length > 0) {
    const last = bars[bars.length - 1];
    const o = ledger.open;
    const exitFee = last.c * o.size * (cfg.simParams.fee_bps / 1e4);
    const realizedPnl = (last.c - o.entry) * o.size - o.entryFee - exitFee;
    ledger = applyClose(ledger, { hitType: 'eod', exitPrice: last.c, exitFee, realizedPnl }, o.openedAt, ds.closeTimeAt(bars.length - 1));
  }

  return { trades: [...ledger.trades], equityCurve, finalLedger: ledger };
}
```

- [ ] **Step 4: Run test → PASS**

Run: `npx vitest run src/lib/backtest/replay-driver.test.ts`
Expected: PASS (3 tests: sin-señal, SL-primero, eod).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/lib/backtest/replay-driver.ts src/lib/backtest/replay-driver.test.ts
git commit -m "feat: driver de replay del backtester (orden pendiente diferida, eod) (SP4)"
```

---

## Task 6: `run-backtest.ts` — orquestación + test end-to-end

**Files:**
- Create: `src/lib/backtest/run-backtest.ts`
- Test: `src/lib/backtest/run-backtest.test.ts`

**Interfaces:**
- Consumes: `getStrategy` (`strategies.ts`), `loadDataSource` (`./data-source.ts`), `runReplay` (`./replay-driver.ts`), `computeMetrics` (`./metrics.ts`), `insertBacktestRun` (`backtest-runs.ts`), `DEFAULT_SIM_PARAMS`/`DEFAULT_SIM_STARTING_EQUITY` (`execution/limits.ts`); `BacktestConfig`/`BacktestResult` (`./types.ts`).
- Produces:
  - `runBacktest(cfg: BacktestConfig): Promise<BacktestResult>`

- [ ] **Step 1: Escribir el test end-to-end (failing)**

Siembra un histórico determinista que dispara `scan` y produce ≥1 trade con cierre por TP. Estrategia con `entry: { all: [] }` (siempre verdadero al pasar el warmup) → la primera barra tras el warmup genera señal; el TP/SL se derivan del ATR. Verifica: ≥1 trade, persistencia, y **reproducibilidad** (dos `runBacktest` → métricas idénticas).

`src/lib/backtest/run-backtest.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { getBacktestRun } from '../../db/repositories/backtest-runs.ts';
import { runBacktest } from './run-backtest.ts';
import type { OhlcvRow } from '../market-data/types.ts';

const SYMBOL = 'RUNBT/USDT';
const STRATEGY_ID = 'runbt-strategy';
const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const RISK = { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 100, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 50, max_drawdown_pct: 90, max_consecutive_losses: 99 };
const TRIGGER_CONFIG = { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] }, allow_counter: true };

const WINDOW_FROM = new Date('2024-03-01T00:00:00Z');
const WINDOW_TO = new Date('2024-03-04T00:00:00Z');

// Velas con una subida suave (ATR>0, EMA alcista) para que scan dispare y el precio alcance el TP.
function gen(tf: string, startMs: number, n: number, base: number, drift: number): OhlcvRow[] {
  return Array.from({ length: n }, (_, k) => {
    const c = base + k * drift;
    const openTime = new Date(startMs + k * TF_MS[tf]);
    return { symbol: SYMBOL, timeframe: tf, openTime, o: c, h: c + drift * 2, l: c - drift, c: c + drift, v: 100 };
  });
}

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, true, '15m', $2::text[], $3::jsonb, $4::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify(TRIGGER_CONFIG), JSON.stringify(RISK)],
  );
  for (const tf of ['15m', '1h', '4h']) {
    const preBars = 360; // > LOOKBACK
    const startMs = WINDOW_FROM.getTime() - preBars * TF_MS[tf];
    const total = preBars + Math.ceil((WINDOW_TO.getTime() - WINDOW_FROM.getTime()) / TF_MS[tf]) + 2;
    await upsertCandles(gen(tf, startMs, total, 100, 0.5));
  }
});
afterAll(async () => {
  await query(`DELETE FROM kairos.backtest_runs WHERE strategy_id = $1`, [STRATEGY_ID]);
  await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('runBacktest end-to-end (sim, det)', () => {
  test('produce trades, métricas y persiste backtest_runs', async () => {
    const res = await runBacktest({ strategyId: STRATEGY_ID, symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } });
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.equityCurve.length).toBeGreaterThan(0);
    expect(Number.isFinite(res.metrics.totalReturnPct)).toBe(true);
    const row = await getBacktestRun(res.runId);
    expect(row).not.toBeNull();
    expect(row!.symbol).toBe(SYMBOL);
    expect((row!.trades as unknown[]).length).toBe(res.trades.length);
  });

  test('reproducible: dos corridas → métricas idénticas', async () => {
    const a = await runBacktest({ strategyId: STRATEGY_ID, symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } });
    const b = await runBacktest({ strategyId: STRATEGY_ID, symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } });
    expect(b.metrics).toEqual(a.metrics);
    expect(b.trades.length).toBe(a.trades.length);
  });

  test('falla rápido si la estrategia no existe', async () => {
    await expect(runBacktest({ strategyId: 'no-existe', symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } }))
      .rejects.toThrow(/estrategia no encontrada/);
  });
});
```

- [ ] **Step 2: Run test → FAIL**

Run: `npx vitest run src/lib/backtest/run-backtest.test.ts`
Expected: FAIL ("Cannot find module './run-backtest.ts'").

- [ ] **Step 3: Implementar `run-backtest.ts`**

`src/lib/backtest/run-backtest.ts`:

```ts
import { getStrategy } from '../../db/repositories/strategies.ts';
import { insertBacktestRun } from '../../db/repositories/backtest-runs.ts';
import { loadDataSource } from './data-source.ts';
import { runReplay } from './replay-driver.ts';
import { computeMetrics } from './metrics.ts';
import { DEFAULT_SIM_PARAMS, DEFAULT_SIM_STARTING_EQUITY } from '../execution/limits.ts';
import type { BacktestConfig, BacktestResult } from './types.ts';

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const strategy = await getStrategy(cfg.strategyId);
  if (!strategy) throw new Error(`estrategia no encontrada: ${cfg.strategyId}`);

  const simParams = cfg.simParams ?? DEFAULT_SIM_PARAMS;
  const startingEquity = cfg.startingEquity ?? DEFAULT_SIM_STARTING_EQUITY;

  const ds = await loadDataSource(strategy, cfg.symbol, cfg.window);
  if (ds.triggerCandles.length === 0) {
    throw new Error(`ventana sin velas trigger para ${cfg.symbol}; ¿falta backfill?`);
  }

  const { trades, equityCurve } = runReplay(strategy, cfg.symbol, ds, { startingEquity, simParams });

  const first = ds.triggerCandles[0];
  const last = ds.triggerCandles[ds.triggerCandles.length - 1];
  // Buy&hold con las mismas fees de sim (spec §3.4): comprar al open inicial, vender al close final.
  const bhFee = simParams.fee_bps / 1e4;
  const metrics = computeMetrics({
    trades, equityCurve, startingEquity,
    buyHold: { entryPrice: first.o * (1 + bhFee), exitPrice: last.c * (1 - bhFee) },
    window: cfg.window,
  });

  const runId = await insertBacktestRun({
    strategyId: strategy.id, strategyVersion: strategy.version, symbol: cfg.symbol,
    window: cfg.window, mode: 'det', simParams,
    metrics: metrics as unknown as Record<string, unknown>,
    trades: trades as unknown[],
  });

  return { runId, symbol: cfg.symbol, metrics, trades, equityCurve };
}
```

- [ ] **Step 4: Run test → PASS**

Run: `npx vitest run src/lib/backtest/run-backtest.test.ts`
Expected: PASS (3 tests). Si el primer test reporta 0 trades, revisar que la estrategia sembrada dispare (warmup + `entry: { all: [] }`); ajustar `drift`/`n` para garantizar que el precio cruce el TP dentro de la ventana.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/lib/backtest/run-backtest.ts src/lib/backtest/run-backtest.test.ts
git commit -m "feat: runBacktest end-to-end + reproducibilidad (SP4)"
```

---

## Task 7: CLI `backtest`

**Files:**
- Create: `src/cli/backtest.ts`
- Modify: `package.json` (script `backtest`)

**Interfaces:**
- Consumes: `runBacktest` (`../lib/backtest/run-backtest.ts`); `DEFAULT_SIM_PARAMS` (`../lib/execution/limits.ts`); Valibot.
- Produces: entrypoint CLI (sin exports consumidos por otros tasks).

- [ ] **Step 1: Añadir el script a `package.json`**

En `"scripts"`, añadir:

```json
"backtest": "node --experimental-strip-types src/cli/backtest.ts"
```

- [ ] **Step 2: Implementar el CLI**

`src/cli/backtest.ts` (sigue el patrón de `src/db/migrate.ts`: dotenv solo al invocar directo, `pool.end()` al terminar). Parseo de args mínimo y validación Valibot en el límite.

```ts
import * as v from 'valibot';
import { runBacktest } from '../lib/backtest/run-backtest.ts';
import type { BacktestResult } from '../lib/backtest/types.ts';

const ArgsSchema = v.object({
  strategy: v.string(),
  symbol: v.array(v.string()),
  from: v.pipe(v.string(), v.isoTimestamp()),
  to: v.pipe(v.string(), v.isoTimestamp()),
  equity: v.optional(v.number()),
});

// Parseo simple de --clave valor (--symbol repetible).
function parseArgv(argv: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { symbol: [] as string[] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const val = argv[i + 1];
    if (!key || val === undefined) continue;
    if (key === 'symbol') (out.symbol as string[]).push(val);
    else if (key === 'equity') out.equity = Number(val);
    else out[key] = val;
  }
  return out;
}

function pct(x: number): string { return `${x.toFixed(2)}%`; }

function printReport(res: BacktestResult): void {
  const m = res.metrics;
  console.log(`\n=== ${res.symbol} (run ${res.runId}) ===`);
  console.log(`Trades: ${m.trades} | Win rate: ${pct(m.winRate)} | Profit factor: ${m.profitFactor ?? 'n/a'}`);
  console.log(`Retorno total: ${pct(m.totalReturnPct)} | CAGR: ${pct(m.cagrPct)} | Buy&Hold: ${pct(m.buyHoldReturnPct)}`);
  console.log(`Sharpe: ${m.sharpe.toFixed(2)} | Sortino: ${m.sortino.toFixed(2)} | Calmar: ${m.calmar.toFixed(2)}`);
  console.log(`Max DD: ${pct(m.maxDrawdownPct)} | Expectancy: ${m.expectancy.toFixed(2)} | Payoff: ${m.payoffRatio ?? 'n/a'}`);
  console.log(`Exposición: ${pct(m.exposurePct)} | Turnover: ${m.turnover.toFixed(2)}`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = v.parse(ArgsSchema, parseArgv(argv));
  const window = { from: new Date(parsed.from), to: new Date(parsed.to) };
  for (const symbol of parsed.symbol) {
    const res = await runBacktest({ strategyId: parsed.strategy, symbol, window, startingEquity: parsed.equity });
    printReport(res);
  }
}

// v8 ignore next 12 — bloque de arranque CLI; se valida ejecutando `npm run backtest`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await import('dotenv/config');
  const { pool } = await import('../db/pool.ts');
  main(process.argv.slice(2))
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Backtest fallido:', error);
      process.exit(1);
    });
}
```

- [ ] **Step 3: Verificación manual (no unit test del entrypoint)**

El bloque de arranque está excluido de cobertura (igual que `migrate.ts`). Verificar manualmente contra la DB sembrada (requiere backfill previo de un símbolo real, p.ej. `BTC/USDT`):

Run: `npm run backtest -- --strategy pullback-alcista --symbol BTC/USDT --from 2024-01-01T00:00:00Z --to 2024-06-30T00:00:00Z`
Expected: imprime el reporte y no lanza. (Si no hay backfill del símbolo/ventana, el error esperado es "ventana sin velas trigger".)

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/cli/backtest.ts package.json
git commit -m "feat: CLI npm run backtest (reporte + persistencia) (SP4)"
```

---

## Cierre de SP4 (tras Task 7)

- [ ] **Suite completa en bucle** (revisión final de rama, lección del flaky de SP2):

Run: `npm test` (×3 para descartar flakiness por orden/colisión).
Expected: toda la suite verde, incluida la de SP1–SP3.

- [ ] **Typecheck global:** `npm run typecheck` sin errores.
- [ ] **Cobertura:** `npx vitest run --coverage` ≥80% en `src/lib/backtest/` y `src/db/repositories/backtest-runs.ts`.
- [ ] **Revisión `kairos-implementation-reviewer`** sobre el diff completo antes del merge.
- [ ] **Merge local a `main`** (opción 1 de `finishing-a-development-branch`), sin push.

---

## Self-Review (cobertura del spec)

| Requisito del spec | Task |
|---|---|
| §3.1 data-source point-in-time (cierre ≤ T) + ventana deslizante | Task 4 |
| §3.2 contabilidad en memoria (Ledger, GatheredState, dailyPnl día-UTC) | Task 2 |
| §3.3 driver: orden pendiente diferida, fill a barra siguiente, SL primero, eod | Task 5 + Task 6 (caminos con señal) |
| §3.4 métricas comprensivas §20.3 | Task 3 |
| §3.5 runBacktest orquestación | Task 6 |
| §3.6 CLI delgado + multi-símbolo iterado | Task 7 |
| §4 DDL backtest_runs (symbol/trades) + repo | Task 1 |
| §5 anti look-ahead (todas las salvaguardas) | Task 4 (cierre ≤ T) + Task 5 (fill barra siguiente, SL primero) + reuso (fees) |
| §6 reproducibilidad | Task 6 (test idéntico) |
| §7 testing (símbolo dedicado, borde día-UTC, borde look-ahead) | Tasks 2/4/6 |
| §8 deuda timezone → no se usa la query DB | N/A (driver usa `T` simulado; anotado) |

**Decisiones de implementación notables:**
- Los caminos del driver **con señal** (fill-a-barra-siguiente, SL-primero, eod) se cubren con tests directos de `runReplay` en Task 5 (fake data-source con snapshot bullish de 260 velas que dispara `scan` + barras crafted), **además** del end-to-end de Task 6. Incorporado tras la revisión (`kairos-plan-reviewer` H1).
- Buy&hold descuenta las fees de sim (Task 6), por paridad con la estrategia (spec §3.4). Incorporado tras la revisión (M1).
- `insertBacktestRun` tipa `metrics`/`trades` como `Record<string, unknown>`/`unknown[]` (Task 1) y Task 6 hace el cast desde los tipos reales — desacopla el repo del módulo `backtest`.

**Deuda menor diferida (no bloqueante, de la revisión):**
- **M2:** `applyClose` final tiene 4 params (`openedAt` explícito) vs los 3 del spec §3.2; benigno (`BracketResolution` es subtipo de `TradeClose`). El plan es la firma autoritativa.
- **L1:** `std()` usa varianza poblacional (÷N) en vez de muestral (÷N−1); diferencia despreciable para validar el edge inicial.
- **L2:** `markToMarket(l, markPrice)` (2 params) vs spec (3, con `T` no usado); benigno.
- **L4:** `recoveryDays` puede reportar `null` si un DD posterior menor sigue sin recuperarse aunque el DD máximo sí; improbable en ventanas cortas. Revisar al añadir ventanas largas.
