# SP3 — Riesgo + ejecución sim · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar el camino del dinero en `sim` de Kairos: de una `signal` del scanner a una posición abierta y cerrada — veredicto determinista → `check_risk` → `paper-sim` fills → `execute_order` idempotente.

**Architecture:** Módulo nuevo `src/lib/execution/` con funciones puras (verdict, sizing, evaluateRisk, fill, bracket) + un orquestador transaccional idempotente (`executeOrderSim`). Persistencia al esquema `kairos` vía repos propios. Ninguna función de mutación se expone a un modelo; todo lo llama código determinista.

**Tech Stack:** TypeScript ESM (Node ≥22.19, `--experimental-strip-types`, imports relativos con extensión `.ts`), Valibot (no zod), PostgreSQL (`pg`), `ulidx`, Vitest. Sin DDL nuevo.

**Spec:** `docs/superpowers/specs/2026-06-25-kairos-fase-1-sp3-riesgo-ejecucion-design.md` (revisado por kairos-design-reviewer). Referencia: `ARCHITECTURE.md` §18/§19.

## Global Constraints

- **Ninguna tool de mutación** (`execute_order`, `check_risk`, etc.) en el `tools:[]` de un agente/modelo. Solo código determinista la llama. (SP3 no declara agentes.)
- **Toda orden lleva `idempotency_key` con `UNIQUE`; el claim (INSERT) ocurre ANTES de simular el fill.** Reintentar nunca duplica.
- **`idempotency_key` de la entry = `signalId`** (el `string` que devuelve `insertSignal`/`scanSymbol`; la `Signal` en memoria **no** tiene `id`). Legs OCO: `${signalId}:sl` / `${signalId}:tp`.
- **SL/TP determinista** — `resolveBracket` es función pura, jamás invoca un LLM.
- **Fill SIEMPRE peor que el mid** — `simulateFill` aplica spread+slippage adversos; el TP llena exacto (sin slippage favorable). Fees siempre restadas.
- **Modo `sim|testnet|live` explícito y persistido**; SP3 es **sim-only** (`mode='sim'`).
- **Ante incertidumbre de ejecución, nunca asumir orden ejecutada** (`pending_execution` existe en el tipo por paridad; en sim el fill es síncrono → no surge).
- **Validación con Valibot** (`v.parse`, lanza ante config malformada). No zod.
- **Porcentajes en `risk_params` son puntos porcentuales** (0.5 = 0.5%); el código divide por 100.
- **Techo duro de código** `MAX_RISK_PER_TRADE = 2.0`; el LLM nunca lo supera.
- **Persistencia transaccional**: el orquestador agrupa sus escrituras en `withTransaction` (primitiva nueva en `pool.ts`); los repos aceptan un `Executor` opcional (default = `query`, autocommit).
- **Tests de integración: símbolo dedicado por archivo** (lección SP2: Vitest corre archivos en paralelo; compartir símbolo causa flakiness). Tablas globales sin símbolo (`account_snapshots`) se prueban por id/valor centinela; el wrapper acepta estado **inyectado** para outcomes deterministas.
- **Estilo**: funciones <50 líneas, archivos <800, anidamiento ≤4, inmutabilidad por defecto, sin secretos hardcodeados, sin `console.log`. Cobertura objetivo ≥80%.
- **Español** en docs/comentarios/commits (con diacríticos); identificadores en inglés; sin atribución en commits.
- **Prerrequisito de tests de integración**: Postgres en marcha (docker compose) y `DATABASE_URL` configurada, igual que SP1/SP2.

---

## Task 1: Tipos, schemas y límites

**Files:**
- Create: `src/lib/execution/types.ts`
- Create: `src/lib/execution/limits.ts`
- Test: `src/lib/execution/types.test.ts`

**Interfaces:**
- Consumes: nada (base del módulo).
- Produces: `Verdict`, `RiskParams`, `SimParams`, `RiskResult` (tipos + schemas Valibot); `parseRiskParams(raw: unknown): RiskParams`; tipos auxiliares `SizeBreakdown`, `RiskInput`, `FillResult`, `PositionForResolve`, `BarOHLC`, `BracketResolution`, `ExecutionResult`. Constantes `MAX_RISK_PER_TRADE=2.0`, `MIN_NOTIONAL=10`, `DEFAULT_SIM_PARAMS`, `DEFAULT_SIM_STARTING_EQUITY=10000`.

- [ ] **Step 1: Write the failing test** — `src/lib/execution/types.test.ts`

```ts
import { describe, test, expect } from 'vitest';
import * as v from 'valibot';
import { parseRiskParams, SimParamsSchema, VerdictSchema } from './types.ts';
import { DEFAULT_SIM_PARAMS, MAX_RISK_PER_TRADE } from './limits.ts';

const VALID_RISK = {
  risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2,
  max_notional_pct: 10, max_total_exposure_pct: 30, max_open_positions: 3,
  max_symbol_exposure_pct: 15, max_daily_loss_pct: 3, max_drawdown_pct: 15,
  max_consecutive_losses: 4,
};

describe('parseRiskParams', () => {
  test('acepta config válida', () => {
    expect(parseRiskParams(VALID_RISK).tp_r_multiple).toBe(2);
  });
  test('lanza si falta un campo requerido', () => {
    const { tp_r_multiple, ...incomplete } = VALID_RISK;
    expect(() => parseRiskParams(incomplete)).toThrow();
  });
  test('lanza si max_open_positions no es entero', () => {
    expect(() => parseRiskParams({ ...VALID_RISK, max_open_positions: 2.5 })).toThrow();
  });
});

describe('VerdictSchema', () => {
  test('rechaza sizingFactor > 1', () => {
    expect(() => v.parse(VerdictSchema, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1.5 })).toThrow();
  });
});

describe('limits + SimParams', () => {
  test('DEFAULT_SIM_PARAMS es un SimParams válido', () => {
    expect(v.parse(SimParamsSchema, DEFAULT_SIM_PARAMS).fee_bps).toBe(10);
  });
  test('MAX_RISK_PER_TRADE es 2.0', () => {
    expect(MAX_RISK_PER_TRADE).toBe(2.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/execution/types.test.ts`
Expected: FAIL (no se resuelven `./types.ts` ni `./limits.ts`).

- [ ] **Step 3: Write `src/lib/execution/types.ts`**

```ts
import * as v from 'valibot';

// ── Verdict (análogo determinista del veredicto del decision-maker) ──
export const VerdictSchema = v.object({
  action: v.picklist(['enter', 'skip']),
  entry: v.number(),
  sl: v.number(),
  tp: v.number(),
  sizingFactor: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  reason: v.optional(v.string()),
});
export type Verdict = v.InferOutput<typeof VerdictSchema>;

// ── RiskParams (config por estrategia; porcentajes en puntos porcentuales) ──
export const RiskParamsSchema = v.object({
  risk_per_trade_pct: v.pipe(v.number(), v.minValue(0)),
  atr_stop_mult: v.pipe(v.number(), v.minValue(0)),
  tp_r_multiple: v.pipe(v.number(), v.minValue(0)),
  max_notional_pct: v.pipe(v.number(), v.minValue(0)),
  max_total_exposure_pct: v.pipe(v.number(), v.minValue(0)),
  max_open_positions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  max_symbol_exposure_pct: v.pipe(v.number(), v.minValue(0)),
  max_daily_loss_pct: v.pipe(v.number(), v.minValue(0)),
  max_drawdown_pct: v.pipe(v.number(), v.minValue(0)),
  max_consecutive_losses: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type RiskParams = v.InferOutput<typeof RiskParamsSchema>;

export function parseRiskParams(raw: unknown): RiskParams {
  return v.parse(RiskParamsSchema, raw);
}

// ── SimParams (modelo de fill paramétrico) ──
export const SimParamsSchema = v.object({
  spread_bps: v.pipe(v.number(), v.minValue(0)),
  slippage_bps: v.pipe(v.number(), v.minValue(0)),
  fee_bps: v.pipe(v.number(), v.minValue(0)),
});
export type SimParams = v.InferOutput<typeof SimParamsSchema>;

// ── RiskResult (salida de check_risk; persistida en risk_evaluations) ──
export const RiskResultSchema = v.object({
  result: v.picklist(['allow', 'deny', 'needs_approval']),
  reason: v.string(),
  adjustedSize: v.nullable(v.number()),
  notional: v.nullable(v.number()),
  limitsSnapshot: v.record(v.string(), v.unknown()),
});
export type RiskResult = v.InferOutput<typeof RiskResultSchema>;

// ── Tipos auxiliares (no Valibot) ──
export interface SizeBreakdown { size: number; notional: number; riskAmount: number; stopDistance: number; }

export interface RiskInput {
  verdict: Verdict;
  riskParams: RiskParams;
  equity: number;
  openNotionalTotal: number;
  openNotionalSymbol: number;
  openPositionsCount: number;
  dailyPnl: number;
  drawdownPct: number;
  consecutiveLosses: number;
}

export interface FillResult { fillPrice: number; qty: number; fee: number; slippageBps: number; }

export interface PositionForResolve { entry: number; size: number; sl: number; tp: number; entryFee: number; }
export interface BarOHLC { open: number; high: number; low: number; close: number; }
export interface BracketResolution { hitType: 'sl' | 'tp'; exitPrice: number; exitFee: number; realizedPnl: number; }

export interface ExecutionResult {
  status: 'filled' | 'pending_execution' | 'duplicate';
  idempotencyKey: string;
  orderId: string;
  positionId: string | null;
  fillPrice: number | null;
  qty: number | null;
  fee: number | null;
}
```

- [ ] **Step 4: Write `src/lib/execution/limits.ts`**

```ts
import type { SimParams } from './types.ts';

// Techo NO negociable de % de riesgo por trade (§19). El LLM nunca lo supera.
export const MAX_RISK_PER_TRADE = 2.0;

// Notional mínimo de una orden (evita órdenes polvo; análogo a minNotional de Binance).
export const MIN_NOTIONAL = 10;

// Modelo de fill paramétrico por defecto (fee 0.1% taker spot; spread/slippage conservadores).
export const DEFAULT_SIM_PARAMS: SimParams = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 };

// Equity de arranque del sim si no hay snapshot previo.
export const DEFAULT_SIM_STARTING_EQUITY = 10000;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/execution/types.test.ts`
Expected: PASS (todos los casos).

- [ ] **Step 6: Commit**

```bash
git add src/lib/execution/types.ts src/lib/execution/limits.ts src/lib/execution/types.test.ts
git commit -m "feat: tipos, schemas Valibot y límites de ejecución (SP3)"
```

---

## Task 2: Primitiva de transacción de dominio

**Files:**
- Modify: `src/db/pool.ts` (añadir `Executor` y `withTransaction`)
- Test: `src/db/pool-transaction.test.ts`

**Interfaces:**
- Consumes: `pool`, `query`, `QueryParam` de `pool.ts`.
- Produces: `type Executor = <T>(text: string, params?: QueryParam[]) => Promise<T[]>`; `withTransaction<T>(fn: (exec: Executor) => Promise<T>): Promise<T>` (BEGIN/COMMIT, ROLLBACK ante throw).

- [ ] **Step 1: Write the failing test** — `src/db/pool-transaction.test.ts` (archivo dedicado con su propio `pool.end()`)

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from './migrate.ts';
import { pool, query, withTransaction } from './pool.ts';

const ACTOR = 'tx-test-actor';

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.audit_log WHERE actor = $1', [ACTOR]);
  await pool.end();
});

describe('withTransaction', () => {
  test('commitea las escrituras cuando el callback resuelve', async () => {
    await withTransaction(async (exec) => {
      await exec(
        `INSERT INTO kairos.audit_log (id, event_type, actor, payload) VALUES ($1,$2,$3,$4)`,
        ['tx-ok-1', 'commit_marker', ACTOR, '{}'],
      );
    });
    const rows = await query('SELECT id FROM kairos.audit_log WHERE id = $1', ['tx-ok-1']);
    expect(rows).toHaveLength(1);
  });

  test('hace rollback cuando el callback lanza', async () => {
    await expect(
      withTransaction(async (exec) => {
        await exec(
          `INSERT INTO kairos.audit_log (id, event_type, actor, payload) VALUES ($1,$2,$3,$4)`,
          ['tx-rollback-1', 'rollback_marker', ACTOR, '{}'],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await query('SELECT id FROM kairos.audit_log WHERE id = $1', ['tx-rollback-1']);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/pool-transaction.test.ts`
Expected: FAIL (`withTransaction` no existe / no es función).

- [ ] **Step 3: Add to `src/db/pool.ts`** (al final, tras `query`)

```ts
export type Executor = <T = Record<string, unknown>>(
  text: string,
  params?: QueryParam[],
) => Promise<T[]>;

// Transacción de dominio: agrupa varios INSERT/UPDATE en un BEGIN/COMMIT.
// El callback recibe un `exec` ligado al client transaccional. Rollback ante throw.
export async function withTransaction<T>(fn: (exec: Executor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exec: Executor = async (text, params) => {
      const result = await client.query(text, params ?? []);
      return result.rows;
    };
    const out = await fn(exec);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/pool-transaction.test.ts`
Expected: PASS (commit y rollback).

- [ ] **Step 5: Commit**

```bash
git add src/db/pool.ts src/db/pool-transaction.test.ts
git commit -m "feat: withTransaction y tipo Executor para repos de dominio (SP3)"
```

---

## Task 3: Productor de veredicto determinista + repo decisions

**Files:**
- Create: `src/lib/execution/verdict.ts`
- Create: `src/db/repositories/decisions.ts`
- Test: `src/lib/execution/verdict.test.ts` (puro), `src/db/repositories/decisions.test.ts` (integración)

**Interfaces:**
- Consumes: `Signal`, `Strategy`, `Features` de `src/lib/scanner/types.ts`; `Verdict`, `parseRiskParams` de `../execution/types.ts`; `query`, `Executor` de `../pool.ts`; `insertSignal` de `./signals.ts` (en el test).
- Produces: `buildDeterministicVerdict(signal: Signal, strategy: Strategy): Verdict`; `persistDecision(signalId: string, verdict: Verdict, exec?: Executor): Promise<DecisionRecord>` con `DecisionRecord = { id: string; verdict: Verdict }`; `getDecision(id: string, exec?: Executor): Promise<DecisionRecord | null>`.

- [ ] **Step 1: Write the failing tests**

`src/lib/execution/verdict.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildDeterministicVerdict } from './verdict.ts';
import type { Signal, Strategy, Features } from '../scanner/types.ts';

function makeStrategy(riskParams: Record<string, unknown>): Strategy {
  return {
    id: 's', enabled: true, symbols: ['BTC/USDT'],
    triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } },
    riskParams, version: 1, skillName: null,
  };
}
function makeSignal(trigger: Partial<Features>): Signal {
  const f: Features = {
    close: 0, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null,
    stochRsi: null, atrPct: null, bbPosition: null, aboveVwap: null, obv: null, mfi: null,
    nearestSupport: null, nearestResistance: null, distToSupportPct: null, ...trigger,
  };
  return {
    strategyId: 's', symbol: 'BTC/USDT', firedAt: new Date('2026-03-01T00:00:00Z'),
    snapshot: { byTimeframe: { '15m': f }, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } },
  };
}
const RP = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 10, max_total_exposure_pct: 30, max_open_positions: 3, max_symbol_exposure_pct: 15, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };

describe('buildDeterministicVerdict', () => {
  test('enter: deriva SL del stop ATR y TP del R-múltiplo', () => {
    // close=100, atrPct=2 → atrAbs=2, stopDistance=1.5*2=3 → sl=97, tp=100+2*3=106
    const v = buildDeterministicVerdict(makeSignal({ close: 100, atrPct: 2 }), makeStrategy(RP));
    expect(v).toMatchObject({ action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1 });
  });
  test('skip cuando atrPct es null', () => {
    expect(buildDeterministicVerdict(makeSignal({ close: 100, atrPct: null }), makeStrategy(RP)).action).toBe('skip');
  });
  test('skip cuando entry ≤ 0', () => {
    expect(buildDeterministicVerdict(makeSignal({ close: 0, atrPct: 2 }), makeStrategy(RP)).action).toBe('skip');
  });
});
```

`src/db/repositories/decisions.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision, getDecision } from './decisions.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'DECISIONBTC/USDT';
const STRATEGY_ID = 'decision-test-strategy';

async function seedSignal(): Promise<string> {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = {
    strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-01T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } },
  };
  return insertSignal(signal);
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('persistDecision', () => {
  test('inserta una decision determinista y la lee de vuelta', async () => {
    const signalId = await seedSignal();
    const { id } = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
    const got = await getDecision(id);
    expect(got?.verdict.tp).toBe(110);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/execution/verdict.test.ts src/db/repositories/decisions.test.ts`
Expected: FAIL (módulos no existen).

- [ ] **Step 3: Write `src/lib/execution/verdict.ts`**

```ts
import type { Signal, Strategy } from '../scanner/types.ts';
import { parseRiskParams, type Verdict } from './types.ts';

// Productor de veredicto determinista (análogo al decision-maker LLM, sin LLM).
// Lee entry/atr del TF trigger del snapshot; deriva SL (stop ATR) y TP (R-múltiplo).
export function buildDeterministicVerdict(signal: Signal, strategy: Strategy): Verdict {
  const triggerTf = strategy.triggerConfig.timeframes.trigger;
  const f = signal.snapshot.byTimeframe[triggerTf];
  const entry = f?.close ?? null;
  const atrPct = f?.atrPct ?? null;

  if (entry === null || entry <= 0 || atrPct === null || atrPct <= 0) {
    return { action: 'skip', entry: 0, sl: 0, tp: 0, sizingFactor: 1, reason: 'atr/entry inválidos' };
  }

  const rp = parseRiskParams(strategy.riskParams);
  const atrAbs = (atrPct / 100) * entry;          // atrPct viene en puntos porcentuales
  const stopDistance = rp.atr_stop_mult * atrAbs;
  const sl = entry - stopDistance;                 // long-only: SL debajo
  const tp = entry + rp.tp_r_multiple * stopDistance;
  return { action: 'enter', entry, sl, tp, sizingFactor: 1.0 };
}
```

- [ ] **Step 4: Write `src/db/repositories/decisions.ts`**

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { Verdict } from '../../lib/execution/types.ts';

export interface DecisionRecord { id: string; verdict: Verdict; }

// Persiste el veredicto determinista como fila decisions (model_used='deterministic').
// signalId = string devuelto por insertSignal/scanSymbol (la Signal en memoria no lleva id).
export async function persistDecision(
  signalId: string, verdict: Verdict, exec: Executor = query,
): Promise<DecisionRecord> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.decisions (id, signal_id, verdict, reasoning, model_used, tokens)
     VALUES ($1, $2, $3, NULL, 'deterministic', 0)`,
    [id, signalId, JSON.stringify(verdict)],
  );
  return { id, verdict };
}

export async function getDecision(id: string, exec: Executor = query): Promise<DecisionRecord | null> {
  const rows = await exec<{ id: string; verdict: Verdict }>(
    `SELECT id, verdict FROM kairos.decisions WHERE id = $1`, [id],
  );
  return rows[0] ? { id: rows[0].id, verdict: rows[0].verdict } : null;
}
```

> Nota: `verdict jsonb` — pg acepta un string JSON como param para columna jsonb (igual que `insertSignal` con `indicator_snapshot`); al leer, pg devuelve un objeto ya parseado.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/execution/verdict.test.ts src/db/repositories/decisions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/execution/verdict.ts src/lib/execution/verdict.test.ts src/db/repositories/decisions.ts src/db/repositories/decisions.test.ts
git commit -m "feat: productor de veredicto determinista y repo decisions (SP3)"
```

---

## Task 4: Sizing fijo-fraccional + stop ATR

**Files:**
- Create: `src/lib/execution/sizing.ts`
- Test: `src/lib/execution/sizing.test.ts`

**Interfaces:**
- Consumes: `MAX_RISK_PER_TRADE` de `./limits.ts`; `Verdict`, `RiskParams`, `SizeBreakdown` de `./types.ts`.
- Produces: `computeSize(equity: number, verdict: Verdict, riskParams: RiskParams): SizeBreakdown`.

- [ ] **Step 1: Write the failing test** — `src/lib/execution/sizing.test.ts`

```ts
import { describe, test, expect } from 'vitest';
import { computeSize } from './sizing.ts';
import type { Verdict, RiskParams } from './types.ts';

const RP = { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 100, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 } as RiskParams;
const V: Verdict = { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 };

describe('computeSize', () => {
  test('el riesgo manda sobre el tamaño', () => {
    // equity=10000, riskPct=1 → riskAmount=100; stopDistance=5 → size=20; notional=2000
    expect(computeSize(10000, V, RP)).toMatchObject({ riskAmount: 100, stopDistance: 5, size: 20, notional: 2000 });
  });
  test('aplica el techo MAX_RISK_PER_TRADE', () => {
    // risk_per_trade_pct=5 pero techo=2 → riskAmount=200; size=40
    const s = computeSize(10000, V, { ...RP, risk_per_trade_pct: 5 });
    expect(s.riskAmount).toBe(200);
    expect(s.size).toBe(40);
  });
  test('sizingFactor reduce el tamaño', () => {
    expect(computeSize(10000, { ...V, sizingFactor: 0.5 }, RP).size).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/execution/sizing.test.ts`
Expected: FAIL (`computeSize` no existe).

- [ ] **Step 3: Write `src/lib/execution/sizing.ts`**

```ts
import { MAX_RISK_PER_TRADE } from './limits.ts';
import type { Verdict, RiskParams, SizeBreakdown } from './types.ts';

// Sizing fijo-fraccional + stop ATR (§19.1). El riesgo manda sobre el tamaño.
export function computeSize(equity: number, verdict: Verdict, riskParams: RiskParams): SizeBreakdown {
  const riskPct = Math.min(riskParams.risk_per_trade_pct, MAX_RISK_PER_TRADE); // techo duro
  const riskAmount = equity * (riskPct / 100);
  const stopDistance = verdict.entry - verdict.sl;          // > 0 en veredicto 'enter'
  const size = (riskAmount / stopDistance) * verdict.sizingFactor;
  const notional = size * verdict.entry;
  return { size, notional, riskAmount, stopDistance };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/execution/sizing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/sizing.ts src/lib/execution/sizing.test.ts
git commit -m "feat: sizing fijo-fraccional con stop ATR y techo duro (SP3)"
```

---

## Task 5: check_risk núcleo puro + repo risk-evaluations

**Files:**
- Create: `src/lib/execution/check-risk.ts` (solo `evaluateRisk`; el wrapper se añade en Task 12)
- Create: `src/db/repositories/risk-evaluations.ts`
- Test: `src/lib/execution/check-risk.test.ts` (puro), `src/db/repositories/risk-evaluations.test.ts` (integración)

**Interfaces:**
- Consumes: `computeSize` de `./sizing.ts`; `MIN_NOTIONAL` de `./limits.ts`; `RiskInput`, `RiskResult` de `./types.ts`; `query`, `Executor` de `../pool.ts`; `persistDecision`/`insertSignal` (en el test de integración).
- Produces: `evaluateRisk(input: RiskInput): RiskResult`; `insertRiskEvaluation(decisionId: string, result: RiskResult, exec?: Executor): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

`src/lib/execution/check-risk.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { evaluateRisk } from './check-risk.ts';
import type { RiskInput, RiskParams, Verdict } from './types.ts';

const RP: RiskParams = { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 50, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const V: Verdict = { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 };
function input(over: Partial<RiskInput> = {}): RiskInput {
  return { verdict: V, riskParams: RP, equity: 10000, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, dailyPnl: 0, drawdownPct: 0, consecutiveLosses: 0, ...over };
}

describe('evaluateRisk', () => {
  test('allow con size capado por riesgo', () => {
    const r = evaluateRisk(input());
    expect(r.result).toBe('allow');
    expect(r.adjustedSize).toBe(20);   // riskAmount 100 / stop 5
  });
  test('deny por drawdown (kill-switch)', () => {
    expect(evaluateRisk(input({ drawdownPct: 15 })).result).toBe('deny');
  });
  test('deny por pérdida diaria', () => {
    expect(evaluateRisk(input({ dailyPnl: -300 })).result).toBe('deny');  // -3% de 10000
  });
  test('deny por pérdidas consecutivas', () => {
    expect(evaluateRisk(input({ consecutiveLosses: 4 })).result).toBe('deny');
  });
  test('deny por concurrencia', () => {
    expect(evaluateRisk(input({ openPositionsCount: 3 })).result).toBe('deny');
  });
  test('cap notional reduce el size', () => {
    const r = evaluateRisk(input({ riskParams: { ...RP, max_notional_pct: 10 } }));
    expect(r.adjustedSize).toBe(10);   // maxNotional 1000 / entry 100
    expect(r.notional).toBe(1000);
  });
  test('deny por exposición total agotada', () => {
    const r = evaluateRisk(input({ openNotionalTotal: 10000, riskParams: { ...RP, max_total_exposure_pct: 50 } }));
    expect(r.result).toBe('deny');     // remaining 5000-10000 < 0
  });
  test('deny por notional bajo el mínimo', () => {
    expect(evaluateRisk(input({ equity: 10 })).result).toBe('deny');  // notional 2 < MIN_NOTIONAL 10
  });
});
```

`src/db/repositories/risk-evaluations.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { insertRiskEvaluation } from './risk-evaluations.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'RISKEVALBTC/USDT';
const STRATEGY_ID = 'riskeval-test-strategy';

async function seedDecision(): Promise<string> {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-03T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const { id } = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return id;
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('insertRiskEvaluation', () => {
  test('persiste el veredicto de check_risk ligado a la decision', async () => {
    const decisionId = await seedDecision();
    const id = await insertRiskEvaluation(decisionId, { result: 'allow', reason: 'ok', adjustedSize: 20, notional: 2000, limitsSnapshot: { equity: 10000 } });
    const rows = await query<{ result: string; adjusted_size: string }>('SELECT result, adjusted_size FROM kairos.risk_evaluations WHERE id = $1', [id]);
    expect(rows[0].result).toBe('allow');
    expect(Number(rows[0].adjusted_size)).toBe(20);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/execution/check-risk.test.ts src/db/repositories/risk-evaluations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/lib/execution/check-risk.ts`**

```ts
import { computeSize } from './sizing.ts';
import { MIN_NOTIONAL } from './limits.ts';
import type { RiskInput, RiskResult } from './types.ts';

function deny(reason: string, snap: Record<string, unknown>): RiskResult {
  return { result: 'deny', reason, adjustedSize: null, notional: null, limitsSnapshot: snap };
}

// Núcleo puro de check_risk (§19.2): deny-gates baratos primero, luego sizing + caps que reducen.
export function evaluateRisk(input: RiskInput): RiskResult {
  const { verdict, riskParams: rp, equity } = input;
  const snap: Record<string, unknown> = {
    equity, drawdownPct: input.drawdownPct, dailyPnl: input.dailyPnl,
    openNotionalTotal: input.openNotionalTotal, openNotionalSymbol: input.openNotionalSymbol,
    openPositionsCount: input.openPositionsCount, consecutiveLosses: input.consecutiveLosses,
  };

  if (input.drawdownPct >= rp.max_drawdown_pct) return deny('drawdown sobre el límite (kill-switch)', snap);
  if ((input.dailyPnl / equity) * 100 <= -rp.max_daily_loss_pct) return deny('pérdida diaria sobre el límite', snap);
  if (input.consecutiveLosses >= rp.max_consecutive_losses) return deny('pérdidas consecutivas sobre el límite', snap);
  if (input.openPositionsCount >= rp.max_open_positions) return deny('máximo de posiciones abiertas alcanzado', snap);

  const base = computeSize(equity, verdict, rp);
  let size = base.size;
  let notional = base.notional;

  const maxNotional = equity * (rp.max_notional_pct / 100);
  if (notional > maxNotional) { size = maxNotional / verdict.entry; notional = size * verdict.entry; }

  const remainingTotal = equity * (rp.max_total_exposure_pct / 100) - input.openNotionalTotal;
  if (remainingTotal <= 0) return deny('exposición total sobre el límite', snap);
  if (notional > remainingTotal) { size = remainingTotal / verdict.entry; notional = size * verdict.entry; }

  const remainingSymbol = equity * (rp.max_symbol_exposure_pct / 100) - input.openNotionalSymbol;
  if (remainingSymbol <= 0) return deny('exposición del símbolo sobre el límite', snap);
  if (notional > remainingSymbol) { size = remainingSymbol / verdict.entry; notional = size * verdict.entry; }

  if (notional < MIN_NOTIONAL) return deny('notional bajo el mínimo', snap);

  return { result: 'allow', reason: 'ok', adjustedSize: size, notional, limitsSnapshot: { ...snap, adjustedSize: size, notional } };
}
```

- [ ] **Step 4: Write `src/db/repositories/risk-evaluations.ts`**

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { RiskResult } from '../../lib/execution/types.ts';

export async function insertRiskEvaluation(
  decisionId: string, result: RiskResult, exec: Executor = query,
): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.risk_evaluations (id, decision_id, result, reason, adjusted_size, limits_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, decisionId, result.result, result.reason, result.adjustedSize, JSON.stringify(result.limitsSnapshot)],
  );
  return id;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/execution/check-risk.test.ts src/db/repositories/risk-evaluations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/execution/check-risk.ts src/lib/execution/check-risk.test.ts src/db/repositories/risk-evaluations.ts src/db/repositories/risk-evaluations.test.ts
git commit -m "feat: check_risk núcleo puro (límites duros) y repo risk-evaluations (SP3)"
```

---

## Task 6: paper-sim — modelo de fill

**Files:**
- Create: `src/lib/execution/fill.ts`
- Test: `src/lib/execution/fill.test.ts`

**Interfaces:**
- Consumes: `SimParams`, `FillResult` de `./types.ts`.
- Produces: `simulateFill(side: 'buy' | 'sell', size: number, referencePrice: number, simParams: SimParams): FillResult`.

- [ ] **Step 1: Write the failing test** — `src/lib/execution/fill.test.ts`

```ts
import { describe, test, expect } from 'vitest';
import { simulateFill } from './fill.ts';
import type { SimParams } from './types.ts';

const SP: SimParams = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 };

describe('simulateFill', () => {
  test('buy llena por encima del referencePrice (peor que mid)', () => {
    // slippageBps = 2+5 = 7 → adverse 0.0007 → 100*1.0007 = 100.07
    const f = simulateFill('buy', 1, 100, SP);
    expect(f.fillPrice).toBeCloseTo(100.07, 6);
    expect(f.fillPrice).toBeGreaterThan(100);
  });
  test('sell llena por debajo del referencePrice (peor que mid)', () => {
    const f = simulateFill('sell', 1, 100, SP);
    expect(f.fillPrice).toBeCloseTo(99.93, 6);
    expect(f.fillPrice).toBeLessThan(100);
  });
  test('fee siempre positiva y proporcional', () => {
    // fee = 100.07 * 2 * 0.001 = 0.20014
    const f = simulateFill('buy', 2, 100, SP);
    expect(f.fee).toBeCloseTo(0.20014, 6);
    expect(f.fee).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/execution/fill.test.ts`
Expected: FAIL (`simulateFill` no existe).

- [ ] **Step 3: Write `src/lib/execution/fill.ts`**

```ts
import type { SimParams, FillResult } from './types.ts';

// paper-sim: precio de llenado SIEMPRE peor que el mid (§10/§18.2). Determinista.
export function simulateFill(
  side: 'buy' | 'sell', size: number, referencePrice: number, simParams: SimParams,
): FillResult {
  const slippageBps = simParams.spread_bps / 2 + simParams.slippage_bps;
  const adverse = slippageBps / 1e4;
  const fillPrice = side === 'buy'
    ? referencePrice * (1 + adverse)   // comprar más caro
    : referencePrice * (1 - adverse);  // vender más barato
  const fee = fillPrice * size * (simParams.fee_bps / 1e4);
  return { fillPrice, qty: size, fee, slippageBps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/execution/fill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/fill.ts src/lib/execution/fill.test.ts
git commit -m "feat: paper-sim modelo de fill paramétrico worse-than-mid (SP3)"
```

---

## Task 7: paper-sim — resolución del bracket OCO

**Files:**
- Create: `src/lib/execution/bracket.ts`
- Test: `src/lib/execution/bracket.test.ts`

**Interfaces:**
- Consumes: `simulateFill` de `./fill.ts`; `SimParams`, `PositionForResolve`, `BarOHLC`, `BracketResolution` de `./types.ts`.
- Produces: `resolveBracket(position: PositionForResolve, bar: BarOHLC, simParams: SimParams): BracketResolution | null`.

- [ ] **Step 1: Write the failing test** — `src/lib/execution/bracket.test.ts`

```ts
import { describe, test, expect } from 'vitest';
import { resolveBracket } from './bracket.ts';
import type { SimParams, PositionForResolve } from './types.ts';

const SP: SimParams = { spread_bps: 0, slippage_bps: 0, fee_bps: 0 }; // sin costos para aislar la lógica
const POS: PositionForResolve = { entry: 100, size: 2, sl: 95, tp: 110, entryFee: 0 };

describe('resolveBracket', () => {
  test('null cuando la vela no toca SL ni TP', () => {
    expect(resolveBracket(POS, { open: 100, high: 105, low: 98, close: 102 }, SP)).toBeNull();
  });
  test('TP: llena exacto a tp, pnl = (tp-entry)*size', () => {
    const r = resolveBracket(POS, { open: 105, high: 111, low: 104, close: 110 }, SP);
    expect(r).toMatchObject({ hitType: 'tp', exitPrice: 110, realizedPnl: 20 });
  });
  test('SL: llena al sl, pnl negativo', () => {
    const r = resolveBracket(POS, { open: 97, high: 98, low: 94, close: 95 }, SP);
    expect(r?.hitType).toBe('sl');
    expect(r?.exitPrice).toBe(95);       // ref = min(95, 97) = 95
    expect(r?.realizedPnl).toBe(-10);    // (95-100)*2
  });
  test('SL gana si la vela toca ambos (peor caso)', () => {
    expect(resolveBracket(POS, { open: 100, high: 111, low: 94, close: 105 }, SP)?.hitType).toBe('sl');
  });
  test('gap-through: abre debajo del SL → llena al open, no al SL', () => {
    const r = resolveBracket(POS, { open: 90, high: 92, low: 88, close: 91 }, SP);
    expect(r?.exitPrice).toBe(90);       // min(95, 90) = 90
    expect(r?.realizedPnl).toBe(-20);    // (90-100)*2
  });
  test('fees reducen el pnl', () => {
    const r = resolveBracket({ ...POS, entryFee: 1 }, { open: 105, high: 111, low: 104, close: 110 }, { spread_bps: 0, slippage_bps: 0, fee_bps: 10 });
    // exitFee = 110*2*0.001 = 0.22; pnl = 20 - 1 - 0.22 = 18.78
    expect(r?.realizedPnl).toBeCloseTo(18.78, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/execution/bracket.test.ts`
Expected: FAIL (`resolveBracket` no existe).

- [ ] **Step 3: Write `src/lib/execution/bracket.ts`**

```ts
import { simulateFill } from './fill.ts';
import type { SimParams, PositionForResolve, BarOHLC, BracketResolution } from './types.ts';

// Resolución pura del bracket OCO en sim. La conduce SP4 (replay) / SP5 (monitor).
// Convención honesta (§20): SL primero si la vela toca ambos; SL=market con slippage y
// gap-through; TP=limit exacto sin slippage favorable.
export function resolveBracket(
  position: PositionForResolve, bar: BarOHLC, simParams: SimParams,
): BracketResolution | null {
  const hitSl = bar.low <= position.sl;
  const hitTp = bar.high >= position.tp;
  if (!hitSl && !hitTp) return null;

  if (hitSl) {
    const ref = Math.min(position.sl, bar.open);   // gap-through: si abre debajo del SL, llena al open
    const exit = simulateFill('sell', position.size, ref, simParams);
    const realizedPnl = (exit.fillPrice - position.entry) * position.size - position.entryFee - exit.fee;
    return { hitType: 'sl', exitPrice: exit.fillPrice, exitFee: exit.fee, realizedPnl };
  }

  const exitFee = position.tp * position.size * (simParams.fee_bps / 1e4);  // TP=limit exacto
  const realizedPnl = (position.tp - position.entry) * position.size - position.entryFee - exitFee;
  return { hitType: 'tp', exitPrice: position.tp, exitFee, realizedPnl };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/execution/bracket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/bracket.ts src/lib/execution/bracket.test.ts
git commit -m "feat: paper-sim resolución del bracket OCO con convención honesta (SP3)"
```

---

## Task 8: Repos de órdenes y fills

**Files:**
- Create: `src/db/repositories/orders.ts`
- Create: `src/db/repositories/fills.ts`
- Test: `src/db/repositories/orders.test.ts` (integración)

**Interfaces:**
- Consumes: `query`, `Executor` de `../pool.ts`; `TradingMode` de `../../lib/mode.ts`; `insertSignal`, `persistDecision` (en el test).
- Produces:
  - `claimEntryOrder(o: EntryOrderInput, exec?: Executor): Promise<{ id: string } | null>` con `EntryOrderInput = { idempotencyKey: string; decisionId: string; size: number; mode: TradingMode }`.
  - `insertBracketLeg(leg: BracketLegInput, exec?: Executor): Promise<string>` con `BracketLegInput = { idempotencyKey: string; decisionId: string; size: number; purpose: 'sl' | 'tp'; parentId: string; mode: TradingMode }`.
  - `getOrderByIdempotencyKey(key: string, exec?: Executor): Promise<OrderRow | null>` con `OrderRow = { id: string; idempotency_key: string; status: string; size: string; mode: string }`.
  - `updateOrderStatus(id: string, status: string, exec?: Executor): Promise<void>`.
  - `insertFill(f: FillInput, exec?: Executor): Promise<string>` con `FillInput = { orderId: string; price: number; qty: number; fee: number }`.

- [ ] **Step 1: Write the failing test** — `src/db/repositories/orders.test.ts`

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { claimEntryOrder, getOrderByIdempotencyKey, updateOrderStatus, insertBracketLeg } from './orders.ts';
import { insertFill } from './fills.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'ORDERSBTC/USDT';
const STRATEGY_ID = 'orders-test-strategy';

async function seedDecision(): Promise<string> {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-02T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const { id } = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return id;
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT id FROM kairos.orders WHERE idempotency_key LIKE $1)`, [`${SYMBOL}%`]);
  await query(`DELETE FROM kairos.orders WHERE idempotency_key LIKE $1`, [`${SYMBOL}%`]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('claimEntryOrder (idempotencia)', () => {
  test('un segundo claim con el mismo idempotency_key devuelve null', async () => {
    const decisionId = await seedDecision();
    const key = `${SYMBOL}:e1`;
    const first = await claimEntryOrder({ idempotencyKey: key, decisionId, size: 1, mode: 'sim' });
    expect(first).not.toBeNull();
    expect(await claimEntryOrder({ idempotencyKey: key, decisionId, size: 1, mode: 'sim' })).toBeNull();
    expect((await getOrderByIdempotencyKey(key))?.status).toBe('pending');
  });

  test('updateOrderStatus + insertFill + bracket legs persisten', async () => {
    const decisionId = await seedDecision();
    const key = `${SYMBOL}:e2`;
    const order = await claimEntryOrder({ idempotencyKey: key, decisionId, size: 1, mode: 'sim' });
    await insertFill({ orderId: order!.id, price: 100.07, qty: 1, fee: 0.1 });
    await updateOrderStatus(order!.id, 'filled');
    await insertBracketLeg({ idempotencyKey: `${key}:sl`, decisionId, size: 1, purpose: 'sl', parentId: order!.id, mode: 'sim' });
    await insertBracketLeg({ idempotencyKey: `${key}:tp`, decisionId, size: 1, purpose: 'tp', parentId: order!.id, mode: 'sim' });
    expect((await getOrderByIdempotencyKey(key))?.status).toBe('filled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/orders.test.ts`
Expected: FAIL (módulos no existen).

- [ ] **Step 3: Write `src/db/repositories/orders.ts`**

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { TradingMode } from '../../lib/mode.ts';

export interface OrderRow { id: string; idempotency_key: string; status: string; size: string; mode: string; }
export interface EntryOrderInput { idempotencyKey: string; decisionId: string; size: number; mode: TradingMode; }
export interface BracketLegInput { idempotencyKey: string; decisionId: string; size: number; purpose: 'sl' | 'tp'; parentId: string; mode: TradingMode; }

// Claim idempotente: INSERT ON CONFLICT DO NOTHING. Devuelve {id} si lo insertó, null si ya existía.
export async function claimEntryOrder(o: EntryOrderInput, exec: Executor = query): Promise<{ id: string } | null> {
  const id = ulid();
  const rows = await exec<{ id: string }>(
    `INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, tif, purpose, status, mode)
     VALUES ($1, $2, $3, 'buy', $4, 'limit', 'IOC', 'entry', 'pending', $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [id, o.idempotencyKey, o.decisionId, o.size, o.mode],
  );
  return rows[0] ? { id: rows[0].id } : null;
}

function legType(purpose: 'sl' | 'tp'): string {
  return purpose === 'sl' ? 'stop_loss_limit' : 'take_profit_limit';
}

export async function insertBracketLeg(leg: BracketLegInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, tif, purpose, parent_id, status, mode)
     VALUES ($1, $2, $3, 'sell', $4, $5, NULL, $6, $7, 'pending', $8)`,
    [id, leg.idempotencyKey, leg.decisionId, leg.size, legType(leg.purpose), leg.purpose, leg.parentId, leg.mode],
  );
  return id;
}

export async function getOrderByIdempotencyKey(key: string, exec: Executor = query): Promise<OrderRow | null> {
  const rows = await exec<OrderRow>(
    `SELECT id, idempotency_key, status, size, mode FROM kairos.orders WHERE idempotency_key = $1`, [key],
  );
  return rows[0] ?? null;
}

export async function updateOrderStatus(id: string, status: string, exec: Executor = query): Promise<void> {
  await exec(`UPDATE kairos.orders SET status = $2 WHERE id = $1`, [id, status]);
}
```

- [ ] **Step 4: Write `src/db/repositories/fills.ts`**

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface FillInput { orderId: string; price: number; qty: number; fee: number; }

export async function insertFill(f: FillInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.fills (id, order_id, price, qty, fee) VALUES ($1, $2, $3, $4, $5)`,
    [id, f.orderId, f.price, f.qty, f.fee],
  );
  return id;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/orders.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/orders.ts src/db/repositories/fills.ts src/db/repositories/orders.test.ts
git commit -m "feat: repos de orders (claim idempotente, legs OCO) y fills (SP3)"
```

---

## Task 9: Repo de posiciones (apertura, cierre, exposición, rachas)

**Files:**
- Create: `src/db/repositories/positions.ts`
- Test: `src/db/repositories/positions.test.ts` (integración)

**Interfaces:**
- Consumes: `query`, `Executor` de `../pool.ts`; `TradingMode` de `../../lib/mode.ts`.
- Produces:
  - `openPosition(p: OpenPositionInput, exec?: Executor): Promise<string>` con `OpenPositionInput = { symbol: string; entry: number; size: number; sl: number; tp: number; strategyId: string; mode: TradingMode }`.
  - `closePosition(id: string, realizedPnl: number, closedAt: Date, exec?: Executor): Promise<void>` (positions no tiene columna de precio de salida; el exit se captura en la `BracketResolution` en memoria).
  - `getExposure(mode: TradingMode, symbol: string, exec?: Executor): Promise<Exposure>` con `Exposure = { openNotionalTotal: number; openNotionalSymbol: number; openPositionsCount: number }` (notional = `entry*size` de posiciones `open`).
  - `getConsecutiveLosses(mode: TradingMode, strategyId: string, exec?: Executor): Promise<number>` (racha por estrategia, para aislar tests y por coherencia con el risk_param por estrategia).
  - `getDailyRealizedPnl(mode: TradingMode, exec?: Executor): Promise<number>` (Σ realized_pnl de cierres desde 00:00 UTC; account-level).

- [ ] **Step 1: Write the failing test** — `src/db/repositories/positions.test.ts` (usa dos símbolos dedicados; asserts exactos solo en valores aislados por símbolo/estrategia)

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { openPosition, closePosition, getExposure, getConsecutiveLosses, getDailyRealizedPnl } from './positions.ts';

const SYMBOL = 'POSBTC/USDT';
const OTHER = 'POSETH/USDT';
const STRATEGY_ID = 'positions-test-strategy';

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL},${OTHER}}`],
  );
});
afterAll(async () => {
  await query('DELETE FROM kairos.positions WHERE symbol IN ($1, $2)', [SYMBOL, OTHER]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('positions', () => {
  test('getExposure suma el notional del símbolo (entry*size) y aísla por símbolo', async () => {
    await openPosition({ symbol: SYMBOL, entry: 100, size: 2, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' }); // 200
    await openPosition({ symbol: SYMBOL, entry: 100, size: 3, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' }); // 300
    await openPosition({ symbol: OTHER, entry: 50, size: 1, sl: 48, tp: 55, strategyId: STRATEGY_ID, mode: 'sim' });    // 50
    const exp = await getExposure('sim', SYMBOL);
    expect(exp.openNotionalSymbol).toBe(500);                  // exacto, aislado por símbolo
    expect(exp.openNotionalTotal).toBeGreaterThanOrEqual(550); // incluye OTHER y posibles de otros archivos
    expect(exp.openPositionsCount).toBeGreaterThanOrEqual(3);
  });

  test('closePosition marca cerrada con realized_pnl; getConsecutiveLosses cuenta la racha por estrategia', async () => {
    const id = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    await closePosition(id, -5, new Date('2026-03-04T00:00:00Z'));
    const id2 = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    await closePosition(id2, -3, new Date('2026-03-04T01:00:00Z'));
    expect(await getConsecutiveLosses('sim', STRATEGY_ID)).toBe(2);
    const closed = await query<{ status: string; realized_pnl: string }>('SELECT status, realized_pnl FROM kairos.positions WHERE id = $1', [id2]);
    expect(closed[0].status).toBe('closed');
    expect(Number(closed[0].realized_pnl)).toBe(-3);
  });

  test('getConsecutiveLosses se rompe en el primer cierre no perdedor', async () => {
    const idWin = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    await closePosition(idWin, 7, new Date('2026-03-04T02:00:00Z')); // cierre ganador más reciente
    expect(await getConsecutiveLosses('sim', STRATEGY_ID)).toBe(0);
  });

  test('getDailyRealizedPnl devuelve un número (Σ cierres del día UTC)', async () => {
    expect(typeof (await getDailyRealizedPnl('sim'))).toBe('number');
  });
});
```

> Nota de aislamiento: `getConsecutiveLosses` filtra por `strategy_id`, así que la racha es exacta y aislada del resto de archivos (que usan otras estrategias). `getDailyRealizedPnl` es account-level (global); su test solo verifica el tipo, no un valor exacto (otros archivos pueden cerrar posiciones `sim` el mismo día).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/positions.test.ts`
Expected: FAIL (`./positions.ts` no existe).

- [ ] **Step 3: Write `src/db/repositories/positions.ts`**

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { TradingMode } from '../../lib/mode.ts';

export interface OpenPositionInput { symbol: string; entry: number; size: number; sl: number; tp: number; strategyId: string; mode: TradingMode; }
export interface Exposure { openNotionalTotal: number; openNotionalSymbol: number; openPositionsCount: number; }

export async function openPosition(p: OpenPositionInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode)
     VALUES ($1, $2, 'long', $3, $4, $5, $6, 'open', $7, $8)`,
    [id, p.symbol, p.entry, p.size, p.sl, p.tp, p.strategyId, p.mode],
  );
  return id;
}

export async function closePosition(id: string, realizedPnl: number, closedAt: Date, exec: Executor = query): Promise<void> {
  await exec(
    `UPDATE kairos.positions SET status = 'closed', realized_pnl = $2, closed_at = $3 WHERE id = $1`,
    [id, realizedPnl, closedAt],
  );
}

export async function getExposure(mode: TradingMode, symbol: string, exec: Executor = query): Promise<Exposure> {
  const rows = await exec<{ total: string; symbol_total: string; cnt: string }>(
    `SELECT COALESCE(SUM(entry * size), 0) AS total,
            COALESCE(SUM(entry * size) FILTER (WHERE symbol = $2), 0) AS symbol_total,
            COUNT(*) AS cnt
       FROM kairos.positions
      WHERE status = 'open' AND mode = $1`,
    [mode, symbol],
  );
  const r = rows[0];
  return {
    openNotionalTotal: Number(r?.total ?? 0),
    openNotionalSymbol: Number(r?.symbol_total ?? 0),
    openPositionsCount: Number(r?.cnt ?? 0),
  };
}

// Racha de cierres con realized_pnl<0 más reciente (por estrategia). Se rompe en el primer no-perdedor.
export async function getConsecutiveLosses(mode: TradingMode, strategyId: string, exec: Executor = query): Promise<number> {
  const rows = await exec<{ realized_pnl: string }>(
    `SELECT realized_pnl FROM kairos.positions
      WHERE status = 'closed' AND mode = $1 AND strategy_id = $2
      ORDER BY closed_at DESC`,
    [mode, strategyId],
  );
  let streak = 0;
  for (const r of rows) {
    if (Number(r.realized_pnl) < 0) streak += 1;
    else break;
  }
  return streak;
}

// P&L realizado del día UTC (account-level). Derivado por query → sin lógica de rollover (§ spec M4).
export async function getDailyRealizedPnl(mode: TradingMode, exec: Executor = query): Promise<number> {
  const rows = await exec<{ pnl: string }>(
    `SELECT COALESCE(SUM(realized_pnl), 0) AS pnl FROM kairos.positions
      WHERE status = 'closed' AND mode = $1
        AND closed_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [mode],
  );
  return Number(rows[0]?.pnl ?? 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/positions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/positions.ts src/db/repositories/positions.test.ts
git commit -m "feat: repo positions (apertura, cierre, exposición, rachas, daily pnl) (SP3)"
```

---

## Task 10: Repo de account_snapshots + executor en appendAuditLog

**Files:**
- Create: `src/db/repositories/account-snapshots.ts`
- Modify: `src/db/repositories/audit-log.ts` (añadir `exec?: Executor`)
- Test: `src/db/repositories/account-snapshots.test.ts` (integración)

**Interfaces:**
- Consumes: `query`, `Executor` de `../pool.ts`.
- Produces:
  - `appendSnapshot(s: AccountSnapshotInput, exec?: Executor): Promise<AccountSnapshot>` con `AccountSnapshotInput = { equity: number; peakEquity: number; drawdown: number; dailyPnl: number }` y `AccountSnapshot = AccountSnapshotInput & { id: string }`.
  - `getLatestSnapshot(exec?: Executor): Promise<AccountSnapshot | null>` (última por `ts`).
  - `ensureInitialSnapshot(startingEquity: number, exec?: Executor): Promise<void>` (inserta solo si la tabla está vacía).
  - `appendAuditLog(entry: AuditLogEntry, exec?: Executor): Promise<string>` (firma extendida con executor opcional; comportamiento por defecto sin cambios).

- [ ] **Step 1: Write the failing test** — `src/db/repositories/account-snapshots.test.ts` (tabla global sin símbolo → asserts por id devuelto y valores centinela)

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { appendSnapshot, getLatestSnapshot, ensureInitialSnapshot } from './account-snapshots.ts';

const SENT_APPEND = 99002;   // equity centinela improbable, para limpieza aislada
const SENT_INITIAL = 99003;

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.account_snapshots WHERE equity IN ($1, $2)', [SENT_APPEND, SENT_INITIAL]);
  await pool.end();
});

describe('account-snapshots', () => {
  test('appendSnapshot inserta y se relee por id', async () => {
    const snap = await appendSnapshot({ equity: SENT_APPEND, peakEquity: SENT_APPEND, drawdown: 0, dailyPnl: 0 });
    const rows = await query<{ equity: string }>('SELECT equity FROM kairos.account_snapshots WHERE id = $1', [snap.id]);
    expect(Number(rows[0].equity)).toBe(SENT_APPEND);
  });

  test('getLatestSnapshot devuelve una fila con forma válida tras un append', async () => {
    await appendSnapshot({ equity: SENT_APPEND, peakEquity: SENT_APPEND, drawdown: 1.5, dailyPnl: -10 });
    const latest = await getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(typeof latest!.equity).toBe('number');
    expect(typeof latest!.drawdown).toBe('number');
  });

  test('ensureInitialSnapshot garantiza al menos un snapshot', async () => {
    await ensureInitialSnapshot(SENT_INITIAL);
    expect(await getLatestSnapshot()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/account-snapshots.test.ts`
Expected: FAIL (`./account-snapshots.ts` no existe).

- [ ] **Step 3: Write `src/db/repositories/account-snapshots.ts`**

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface AccountSnapshotInput { equity: number; peakEquity: number; drawdown: number; dailyPnl: number; }
export interface AccountSnapshot extends AccountSnapshotInput { id: string; }

export async function appendSnapshot(s: AccountSnapshotInput, exec: Executor = query): Promise<AccountSnapshot> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.account_snapshots (id, equity, peak_equity, drawdown, daily_pnl)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, s.equity, s.peakEquity, s.drawdown, s.dailyPnl],
  );
  return { id, ...s };
}

export async function getLatestSnapshot(exec: Executor = query): Promise<AccountSnapshot | null> {
  const rows = await exec<{ id: string; equity: string; peak_equity: string; drawdown: string; daily_pnl: string }>(
    `SELECT id, equity, peak_equity, drawdown, daily_pnl
       FROM kairos.account_snapshots ORDER BY ts DESC LIMIT 1`,
  );
  const r = rows[0];
  return r ? { id: r.id, equity: Number(r.equity), peakEquity: Number(r.peak_equity), drawdown: Number(r.drawdown), dailyPnl: Number(r.daily_pnl) } : null;
}

// Siembra la equity de arranque del sim si aún no hay ningún snapshot (bootstrap del loop, SP5).
export async function ensureInitialSnapshot(startingEquity: number, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.account_snapshots (id, equity, peak_equity, drawdown, daily_pnl)
     SELECT $1, $2, $2, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM kairos.account_snapshots)`,
    [ulid(), startingEquity],
  );
}
```

- [ ] **Step 4: Modify `src/db/repositories/audit-log.ts`** — añadir executor opcional

Reemplazar la firma y el cuerpo de `appendAuditLog` por:

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface AuditLogEntry {
  eventType: string;
  actor: string;
  payload?: Record<string, unknown>;
}

// Append-first: el rastro de auditoría solo crece, nunca se actualiza ni borra.
export async function appendAuditLog(entry: AuditLogEntry, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.audit_log (id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4)`,
    [id, entry.eventType, entry.actor, JSON.stringify(entry.payload ?? {})],
  );
  return id;
}
```

- [ ] **Step 5: Run tests to verify they pass** (incluye la regresión de audit-log)

Run: `npx vitest run src/db/repositories/account-snapshots.test.ts src/db/repositories/audit-log.test.ts`
Expected: PASS (account-snapshots nuevos + audit-log existente sigue verde con el param opcional).

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/account-snapshots.ts src/db/repositories/account-snapshots.test.ts src/db/repositories/audit-log.ts
git commit -m "feat: repo account-snapshots y executor opcional en appendAuditLog (SP3)"
```

---

## Task 11: Orquestador execute_order en sim

**Files:**
- Create: `src/lib/execution/execute-order.ts`
- Test: `src/db/repositories/execute-order.test.ts` (integración; vive junto a la DB por las FKs que ejercita)

**Interfaces:**
- Consumes: `withTransaction` de `../../db/pool.ts`; `claimEntryOrder`, `insertBracketLeg`, `updateOrderStatus`, `getOrderByIdempotencyKey` de `../../db/repositories/orders.ts`; `insertFill` de `../../db/repositories/fills.ts`; `openPosition` de `../../db/repositories/positions.ts`; `appendAuditLog` de `../../db/repositories/audit-log.ts`; `simulateFill` de `./fill.ts`; `Verdict`, `RiskResult`, `SimParams`, `ExecutionResult` de `./types.ts`; `Strategy` de `../scanner/types.ts`; `TradingMode` de `../mode.ts`.
- Produces: `executeOrderSim(p: ExecuteOrderSimParams): Promise<ExecutionResult>` con `ExecuteOrderSimParams = { signalId: string; symbol: string; decision: { id: string; verdict: Verdict }; riskResult: RiskResult; strategy: Strategy; referencePrice: number; simParams: SimParams; mode: TradingMode }`.

- [ ] **Step 1: Write the failing test** — `src/db/repositories/execute-order.test.ts`

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { executeOrderSim } from '../../lib/execution/execute-order.ts';
import { DEFAULT_SIM_PARAMS } from '../../lib/execution/limits.ts';
import type { Signal, Strategy } from '../../lib/scanner/types.ts';
import type { RiskResult } from '../../lib/execution/types.ts';

const SYMBOL = 'EXECBTC/USDT';
const STRATEGY_ID = 'exec-test-strategy';

const STRATEGY: Strategy = {
  id: STRATEGY_ID, enabled: true, symbols: [SYMBOL],
  triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } },
  riskParams: {}, version: 1, skillName: null,
};
const RISK_ALLOW: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 1, notional: 100, limitsSnapshot: {} };

async function seedSignalAndDecision() {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-05T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return { signalId, decision };
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id = o.decision_id JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('executeOrderSim', () => {
  test('abre una posición y el fill es peor que el referencePrice', async () => {
    const { signalId, decision } = await seedSignalAndDecision();
    const r = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(r.status).toBe('filled');
    expect(r.positionId).not.toBeNull();
    expect(r.fillPrice!).toBeGreaterThan(100);   // peor que mid en buy
  });

  test('idempotencia: repetir con el mismo signalId no duplica la posición', async () => {
    const { signalId, decision } = await seedSignalAndDecision();
    const first = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    const second = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(first.status).toBe('filled');
    expect(second.status).toBe('duplicate');
    const cnt = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol = $1 AND mode = 'sim'`, [SYMBOL]);
    expect(Number(cnt[0].n)).toBe(1);
  });
});
```

> Nota: el segundo `seedSignalAndDecision` del test de idempotencia genera un `signalId` distinto, así que ambos tests son independientes; la idempotencia se prueba repitiendo el MISMO `signalId` dentro del segundo test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/execute-order.test.ts`
Expected: FAIL (`execute-order.ts` no existe).

- [ ] **Step 3: Write `src/lib/execution/execute-order.ts`**

```ts
import { withTransaction } from '../../db/pool.ts';
import { claimEntryOrder, insertBracketLeg, updateOrderStatus, getOrderByIdempotencyKey } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { openPosition } from '../../db/repositories/positions.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { simulateFill } from './fill.ts';
import type { Verdict, RiskResult, SimParams, ExecutionResult } from './types.ts';
import type { Strategy } from '../scanner/types.ts';
import type { TradingMode } from '../mode.ts';

export interface ExecuteOrderSimParams {
  signalId: string;
  symbol: string;
  decision: { id: string; verdict: Verdict };
  riskResult: RiskResult;
  strategy: Strategy;
  referencePrice: number;
  simParams: SimParams;
  mode: TradingMode;
}

// Orquestador determinista e idempotente del camino del dinero en sim. Una transacción.
export async function executeOrderSim(p: ExecuteOrderSimParams): Promise<ExecutionResult> {
  const idem = p.signalId;                 // §18.3: idempotency_key = signalId
  const size = p.riskResult.adjustedSize;
  if (p.riskResult.result !== 'allow' || size === null) {
    throw new Error('executeOrderSim requiere un riskResult allow con adjustedSize');
  }

  return withTransaction(async (exec) => {
    const claimed = await claimEntryOrder({ idempotencyKey: idem, decisionId: p.decision.id, size, mode: p.mode }, exec);
    if (!claimed) {
      const existing = await getOrderByIdempotencyKey(idem, exec);
      return { status: 'duplicate', idempotencyKey: idem, orderId: existing!.id, positionId: null, fillPrice: null, qty: null, fee: null };
    }

    const fill = simulateFill('buy', size, p.referencePrice, p.simParams);
    await insertFill({ orderId: claimed.id, price: fill.fillPrice, qty: fill.qty, fee: fill.fee }, exec);
    const positionId = await openPosition(
      { symbol: p.symbol, entry: fill.fillPrice, size: fill.qty, sl: p.decision.verdict.sl, tp: p.decision.verdict.tp, strategyId: p.strategy.id, mode: p.mode },
      exec,
    );
    await updateOrderStatus(claimed.id, 'filled', exec);
    await insertBracketLeg({ idempotencyKey: `${idem}:sl`, decisionId: p.decision.id, size: fill.qty, purpose: 'sl', parentId: claimed.id, mode: p.mode }, exec);
    await insertBracketLeg({ idempotencyKey: `${idem}:tp`, decisionId: p.decision.id, size: fill.qty, purpose: 'tp', parentId: claimed.id, mode: p.mode }, exec);
    await appendAuditLog({ eventType: 'order_filled_sim', actor: 'execute_order', payload: { idem, positionId, fillPrice: fill.fillPrice, qty: fill.qty } }, exec);

    return { status: 'filled', idempotencyKey: idem, orderId: claimed.id, positionId, fillPrice: fill.fillPrice, qty: fill.qty, fee: fill.fee };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/execute-order.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/execute-order.ts src/db/repositories/execute-order.test.ts
git commit -m "feat: execute_order sim idempotente y transaccional (SP3)"
```

---

## Task 12: Wrapper checkRiskForDecision

**Files:**
- Modify: `src/lib/execution/check-risk.ts` (añadir el wrapper DB; `evaluateRisk` ya existe de Task 5)
- Test: `src/db/repositories/check-risk-wrapper.test.ts` (integración)

**Interfaces:**
- Consumes: `evaluateRisk` (mismo archivo); `parseRiskParams` de `./types.ts`; `DEFAULT_SIM_STARTING_EQUITY` de `./limits.ts`; `getExposure`, `getConsecutiveLosses`, `getDailyRealizedPnl` de `../../db/repositories/positions.ts`; `getLatestSnapshot` de `../../db/repositories/account-snapshots.ts`; `insertRiskEvaluation` de `../../db/repositories/risk-evaluations.ts`; `Strategy` de `../scanner/types.ts`; `TradingMode` de `../mode.ts`; `Verdict`, `RiskResult` de `./types.ts`.
- Produces: `GatheredState` (interface); `checkRiskForDecision(args: CheckRiskArgs, injected?: GatheredState): Promise<RiskResult>` con `CheckRiskArgs = { decision: { id: string; verdict: Verdict }; strategy: Strategy; symbol: string; mode: TradingMode }`.

- [ ] **Step 1: Write the failing test** — `src/db/repositories/check-risk-wrapper.test.ts`

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { checkRiskForDecision, type GatheredState } from '../../lib/execution/check-risk.ts';
import type { Signal, Strategy } from '../../lib/scanner/types.ts';

const SYMBOL = 'RISKWBTC/USDT';
const STRATEGY_ID = 'riskw-test-strategy';
const RISK_PARAMS = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 10, max_total_exposure_pct: 30, max_open_positions: 3, max_symbol_exposure_pct: 15, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: RISK_PARAMS, version: 1, skillName: null };
const STATE: GatheredState = { equity: 100000, drawdownPct: 0, dailyPnl: 0, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, consecutiveLosses: 0 };

async function seedDecision(verdict = { action: 'enter' as const, entry: 100, sl: 97, tp: 106, sizingFactor: 1 }) {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-06T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  return persistDecision(signalId, verdict);
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('checkRiskForDecision', () => {
  test('con estado inyectado: allow y persiste risk_evaluations', async () => {
    const decision = await seedDecision();
    const result = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' }, STATE);
    expect(result.result).toBe('allow');
    const rows = await query<{ result: string }>('SELECT result FROM kairos.risk_evaluations WHERE decision_id = $1', [decision.id]);
    expect(rows[0]?.result).toBe('allow');
  });

  test('con estado inyectado: deny por drawdown', async () => {
    const decision = await seedDecision();
    const result = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' }, { ...STATE, drawdownPct: 20 });
    expect(result.result).toBe('deny');
  });

  test('sin inyección (lee de la DB): devuelve un enum válido y persiste (tolerante)', async () => {
    const decision = await seedDecision();
    const result = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' });
    expect(['allow', 'deny', 'needs_approval']).toContain(result.result);
    const rows = await query('SELECT 1 FROM kairos.risk_evaluations WHERE decision_id = $1', [decision.id]);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/check-risk-wrapper.test.ts`
Expected: FAIL (`checkRiskForDecision` / `GatheredState` no exportados).

- [ ] **Step 3: Append to `src/lib/execution/check-risk.ts`** (tras `evaluateRisk`)

```ts
import { parseRiskParams } from './types.ts';
import { DEFAULT_SIM_STARTING_EQUITY } from './limits.ts';
import { getExposure, getConsecutiveLosses, getDailyRealizedPnl } from '../../db/repositories/positions.ts';
import { getLatestSnapshot } from '../../db/repositories/account-snapshots.ts';
import { insertRiskEvaluation } from '../../db/repositories/risk-evaluations.ts';
import type { Verdict } from './types.ts';
import type { Strategy } from '../scanner/types.ts';
import type { TradingMode } from '../mode.ts';

export interface GatheredState {
  equity: number; drawdownPct: number; dailyPnl: number;
  openNotionalTotal: number; openNotionalSymbol: number; openPositionsCount: number;
  consecutiveLosses: number;
}
export interface CheckRiskArgs {
  decision: { id: string; verdict: Verdict };
  strategy: Strategy;
  symbol: string;
  mode: TradingMode;
}

async function gatherState(args: CheckRiskArgs): Promise<GatheredState> {
  const snap = await getLatestSnapshot();
  const exposure = await getExposure(args.mode, args.symbol);
  const consecutiveLosses = await getConsecutiveLosses(args.mode, args.strategy.id);
  const dailyPnl = await getDailyRealizedPnl(args.mode);
  return {
    equity: snap?.equity ?? DEFAULT_SIM_STARTING_EQUITY,
    drawdownPct: snap?.drawdown ?? 0,
    dailyPnl,
    openNotionalTotal: exposure.openNotionalTotal,
    openNotionalSymbol: exposure.openNotionalSymbol,
    openPositionsCount: exposure.openPositionsCount,
    consecutiveLosses,
  };
}

// Wrapper DB de check_risk: reúne el estado (o lo recibe inyectado en tests), evalúa y persiste.
export async function checkRiskForDecision(args: CheckRiskArgs, injected?: GatheredState): Promise<RiskResult> {
  const state = injected ?? (await gatherState(args));
  const result = evaluateRisk({
    verdict: args.decision.verdict,
    riskParams: parseRiskParams(args.strategy.riskParams),
    ...state,
  });
  await insertRiskEvaluation(args.decision.id, result);
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/check-risk-wrapper.test.ts`
Expected: PASS (los 3 casos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/check-risk.ts src/db/repositories/check-risk-wrapper.test.ts
git commit -m "feat: wrapper checkRiskForDecision (estado DB inyectable) (SP3)"
```

---

## Task 13: Extensión del seed de risk_params + bump de version

**Files:**
- Modify: `src/db/seed-strategies.ts` (extender `RISK_PARAMS`, subir `version` a 2)
- Test: `src/db/seed-strategies.test.ts` (integración)

**Interfaces:**
- Consumes: `seedStrategies` de `./seed-strategies.ts`; `getStrategy` de `./repositories/strategies.ts`; `parseRiskParams` de `../lib/execution/types.ts`.
- Produces: estrategia semilla `pullback-alcista` con `risk_params` completo (10 campos) y `version=2`.

- [ ] **Step 1: Write the failing test** — `src/db/seed-strategies.test.ts`

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from './migrate.ts';
import { pool } from './pool.ts';
import { seedStrategies } from './seed-strategies.ts';
import { getStrategy } from './repositories/strategies.ts';
import { parseRiskParams } from '../lib/execution/types.ts';

beforeAll(async () => { await migrate(); });
afterAll(async () => { await pool.end(); });

describe('seedStrategies', () => {
  test('pullback-alcista tiene risk_params completo (parseable) y version 2', async () => {
    await seedStrategies();
    const strategy = await getStrategy('pullback-alcista');
    expect(strategy).not.toBeNull();
    const rp = parseRiskParams(strategy!.riskParams);   // lanza si falta algún campo
    expect(rp.tp_r_multiple).toBe(2);
    expect(rp.max_open_positions).toBe(3);
    expect(strategy!.version).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/seed-strategies.test.ts`
Expected: FAIL (`parseRiskParams` lanza por campos faltantes; `version` es 1).

- [ ] **Step 3: Modify `src/db/seed-strategies.ts`**

Reemplazar la constante `RISK_PARAMS` por:

```ts
const RISK_PARAMS = {
  risk_per_trade_pct: 0.5,
  atr_stop_mult: 1.5,
  tp_r_multiple: 2.0,
  max_notional_pct: 10,
  max_total_exposure_pct: 30,
  max_open_positions: 3,
  max_symbol_exposure_pct: 15,
  max_daily_loss_pct: 3,
  max_drawdown_pct: 15,
  max_consecutive_losses: 4,
};
```

Y subir la `version` a 2 en el INSERT y el UPDATE. El SQL pasa a:

```ts
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, true, '15m', $2::text[], $3, $4, 2)
     ON CONFLICT (id) DO UPDATE
       SET trigger_config = EXCLUDED.trigger_config,
           risk_params    = EXCLUDED.risk_params,
           enabled        = EXCLUDED.enabled,
           timeframe      = EXCLUDED.timeframe,
           version        = EXCLUDED.version`,
    ['pullback-alcista', '{BTC/USDT,ETH/USDT}', JSON.stringify(TRIGGER_CONFIG), JSON.stringify(RISK_PARAMS)],
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/seed-strategies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/seed-strategies.ts src/db/seed-strategies.test.ts
git commit -m "feat: seed con risk_params completo y bump de version a 2 (SP3)"
```

---

## Task 14: Integración end-to-end (signal → veredicto → check_risk → execute → cierre)

**Files:**
- Test: `src/db/repositories/sp3-e2e.test.ts` (integración; símbolo y estrategia dedicados)

**Interfaces:**
- Consumes: `buildDeterministicVerdict`, `persistDecision`, `checkRiskForDecision` (+ `GatheredState`), `executeOrderSim`, `resolveBracket`, `closePosition`, `DEFAULT_SIM_PARAMS`, `insertSignal`. (Todo de tareas previas.)
- Produces: nada (test de cobertura del flujo completo).

- [ ] **Step 1: Write the failing test** — `src/db/repositories/sp3-e2e.test.ts`

```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { closePosition } from './positions.ts';
import { buildDeterministicVerdict } from '../../lib/execution/verdict.ts';
import { checkRiskForDecision, type GatheredState } from '../../lib/execution/check-risk.ts';
import { executeOrderSim } from '../../lib/execution/execute-order.ts';
import { resolveBracket } from '../../lib/execution/bracket.ts';
import { DEFAULT_SIM_PARAMS } from '../../lib/execution/limits.ts';
import type { Signal, Strategy, Features } from '../../lib/scanner/types.ts';

const SYMBOL = 'E2EBTC/USDT';
const STRATEGY_ID = 'e2e-test-strategy';
const RISK_PARAMS = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 50, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: RISK_PARAMS, version: 2, skillName: null };
const STATE: GatheredState = { equity: 100000, drawdownPct: 0, dailyPnl: 0, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, consecutiveLosses: 0 };

function features(close: number, atrPct: number): Features {
  return { close, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null, stochRsi: null, atrPct, bbPosition: null, aboveVwap: null, obv: null, mfi: null, nearestSupport: null, nearestResistance: null, distToSupportPct: null };
}

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 2) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
});
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id = o.decision_id JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('SP3 end-to-end (sim)', () => {
  test('signal → veredicto → check_risk(allow) → execute → cierre por TP', async () => {
    // 1. Signal con features del TF trigger (close=100, atrPct=2 → sl=97, tp=106).
    const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-07T00:00:00Z'),
      snapshot: { byTimeframe: { '15m': features(100, 2) }, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
    const signalId = await insertSignal(signal);

    // 2. Veredicto determinista.
    const verdict = buildDeterministicVerdict(signal, STRATEGY);
    expect(verdict).toMatchObject({ action: 'enter', entry: 100, sl: 97, tp: 106 });

    // 3. Persistir decision.
    const decision = await persistDecision(signalId, verdict);

    // 4. check_risk con estado inyectado (determinista) → allow.
    const riskResult = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' }, STATE);
    expect(riskResult.result).toBe('allow');

    // 5. execute_order → posición abierta.
    const exec1 = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult, strategy: STRATEGY, referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(exec1.status).toBe('filled');
    expect(exec1.positionId).not.toBeNull();

    // 6. Idempotencia: repetir → duplicate, sigue 1 posición.
    const exec2 = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult, strategy: STRATEGY, referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(exec2.status).toBe('duplicate');
    const cnt = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol = $1 AND mode = 'sim'`, [SYMBOL]);
    expect(Number(cnt[0].n)).toBe(1);

    // 7. Cierre por TP: leer la posición y su fee de entrada, resolver con una vela que toca TP.
    const posRows = await query<{ id: string; entry: string; size: string; sl: string; tp: string }>(`SELECT id, entry, size, sl, tp FROM kairos.positions WHERE symbol = $1 AND status = 'open'`, [SYMBOL]);
    const pos = posRows[0];
    const feeRows = await query<{ fee: string }>(`SELECT fee FROM kairos.fills WHERE order_id = $1`, [exec1.orderId]);
    const entryFee = Number(feeRows[0].fee);
    const tp = Number(pos.tp);
    const resolution = resolveBracket(
      { entry: Number(pos.entry), size: Number(pos.size), sl: Number(pos.sl), tp, entryFee },
      { open: tp, high: tp + 1, low: Number(pos.entry), close: tp },
      DEFAULT_SIM_PARAMS,
    );
    expect(resolution?.hitType).toBe('tp');

    await closePosition(pos.id, resolution!.realizedPnl, new Date('2026-03-07T01:00:00Z'));
    const closed = await query<{ status: string; realized_pnl: string }>(`SELECT status, realized_pnl FROM kairos.positions WHERE id = $1`, [pos.id]);
    expect(closed[0].status).toBe('closed');
    expect(Number(closed[0].realized_pnl)).toBeCloseTo(resolution!.realizedPnl, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes if deps complete)**

Run: `npx vitest run src/db/repositories/sp3-e2e.test.ts`
Expected: Si todas las tareas previas están, debería PASS al primer intento (no hay código nuevo, solo integración). Si falla, es señal de un mismatch de interfaz entre tareas → corregir antes de continuar.

- [ ] **Step 3: Run the FULL suite to confirm no regressions**

Run: `npm test`
Expected: PASS (toda la suite: SP1 + SP2 + SP3). Si algún test de integración nuevo es flaky al correr en paralelo, revisar que cada archivo use símbolo/estrategia dedicados (no compartidos) — repetir `npm test` 2-3 veces para confirmar estabilidad (lección SP2).

- [ ] **Step 4: Commit**

```bash
git add src/db/repositories/sp3-e2e.test.ts
git commit -m "test: integración end-to-end del camino del dinero en sim (SP3)"
```

---

## Notas para el ejecutor

- **Orden estricto**: las tareas 1→14 tienen dependencias en cadena (tipos → puros → repos → orquestador → wrapper → e2e). No reordenar.
- **`exec` opcional**: todos los repos de SP3 aceptan `exec: Executor = query`. Fuera de transacción se omite (autocommit); dentro de `executeOrderSim` se pasa el `exec` transaccional. No olvidar el parámetro al escribir cada repo, o el orquestador no podrá agruparlos atómicamente.
- **jsonb**: insertar con `JSON.stringify(...)` como param (pg castea text→jsonb); al leer, pg devuelve objeto ya parseado (no hacer `JSON.parse`).
- **numeric de pg**: siempre `Number(...)` al leer columnas `numeric` (vienen como string).
- **Símbolo/estrategia dedicados por archivo de test** que toque DB. Tablas globales sin símbolo (`account_snapshots`): asserts por id devuelto o valor centinela; nunca asumir que `getLatestSnapshot` devuelve la fila propia bajo paralelismo.
- **Línea roja**: `idempotency_key` (claim) se inserta ANTES de `simulateFill`; el fill siempre da precio peor que el mid; SL/TP nunca invoca un LLM.
