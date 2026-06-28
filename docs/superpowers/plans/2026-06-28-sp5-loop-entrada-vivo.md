# SP5 — Loop de entrada vivo (sin LLM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Llevar el camino de ENTRADA del bot (scanner → veredicto determinista → risk gate → ejecución sim → notify) del estado "piezas sueltas testeadas" a un **loop vivo dirigido por código y encolado en BullMQ**, todavía sin LLM y en modo `sim`.

**Architecture:** Un orquestador determinista `evaluateCandidate(signalId)` empaqueta el encadenamiento que el test SP3-e2e ya prueba a mano (`buildDeterministicVerdict → persistDecision → checkRiskForDecision → executeOrderSim → notify`), recargando señal y estrategia desde Postgres (fuente de verdad). Un **scan tick** (`runScanTick`) recorre las estrategias activas y, por cada señal disparada, **encola** un job `evaluate-candidate` con `jobId = signalId` (la cola deduplica). La espina durable es **BullMQ sobre Redis `noeviction`** (`REDIS_BULLMQ_URL`). La lógica de negocio se testea con Postgres real + inyección de dependencias (mismo patrón que `checkRiskForDecision`); el acoplamiento a BullMQ/Redis se aísla en wrappers delgados con su parte pura testeada por separado, para no meter Redis en la suite unit.

**Tech Stack:** TypeScript (Node ≥22.19, `--experimental-strip-types`), BullMQ + ioredis (recién instalados), Postgres (esquema `kairos`), Valibot, Vitest (integración con DB real).

## Global Constraints

- **Modo:** todo corre en `sim` vía `getMode()` (`src/lib/mode.ts`). Nada toca dinero real en SP5. Copiar `mode` explícito a cada llamada que lo pida (`checkRiskForDecision`, `executeOrderSim`).
- **Línea roja de seguridad:** `evaluateCandidate`, `runScanTick` y los workers son **código determinista de orquestación**. NINGUNA tool de mutación entra al `tools:[]` de un agente/modelo (no hay modelos en SP5). El bucle de tool-calling del LLM jamás dispara una orden.
- **Idempotencia:** la clave es `signalId`. `executeOrderSim` ya es idempotente (`idempotency_key = signalId`, `UNIQUE` en `orders`). La cola añade una segunda capa: `jobId = signalId` → BullMQ no encola dos jobs con el mismo id. Reintentar nunca duplica.
- **Durabilidad:** ante incertidumbre, nunca se asume una orden ejecutada — `executeOrderSim` ya devuelve `status: 'pending_execution'` cuando aplica; el orquestador propaga ese estado y notifica, nunca lo "promueve" a filled.
- **Estilo:** funciones <50 líneas, archivos <800, sin anidamiento >4 niveles, inmutabilidad por defecto, validación en los límites, sin secretos hardcodeados, sin `console.log` de debug. Validación con **Valibot** (no zod).
- **Verificación con la doc real de Flue/BullMQ:** confirmar firmas de BullMQ (`Queue`, `Worker`, `add`, `jobId`) contra su doc/tipos antes de usarlas, no de memoria. BullMQ exige `maxRetriesPerRequest: null` en la conexión ioredis.
- **Cobertura:** Vitest con umbral 80% (lines/functions/branches/statements). Cada tarea deja su test.
- **Tests de integración:** patrón del repo — `beforeAll(migrate)` + seed, `afterAll` cleanup + `pool.end()`. `dotenv/config` ya carga `.env` vía `vitest.setup.ts`. Requieren Postgres del `docker-compose.yml` arriba.

---

## File Structure

**Crear:**
- `src/db/repositories/signals.ts` → añadir `getSignalById` (recarga `Signal` desde fila). *(modificar)*
- `src/workflows/evaluate-candidate.ts` → `evaluateCandidate(signalId, deps?)` + tipo `EvaluateOutcome`. Orquestador determinista de entrada.
- `src/lib/queue/connection.ts` → conexión ioredis singleton para BullMQ (lee `REDIS_BULLMQ_URL`).
- `src/lib/queue/evaluate-queue.ts` → `buildEvaluateJob` (puro, testeable) + `enqueueEvaluateCandidate` (wrapper BullMQ) + constantes de cola.
- `src/lib/scanner/scan-tick.ts` → `runScanTick(deps?)`: recorre estrategias activas y encola candidatos.
- `src/lib/queue/evaluate-worker.ts` → `startEvaluateWorker()`: Worker BullMQ que procesa la cola llamando a `evaluateCandidate`.
- `src/worker.ts` → entrypoint del proceso de workers (arranca worker + agenda el scan tick repetible).

**Tests (junto a cada archivo):**
- `src/db/repositories/signals.test.ts` *(crear/extender)*
- `src/workflows/evaluate-candidate.test.ts`
- `src/lib/queue/evaluate-queue.test.ts`
- `src/lib/scanner/scan-tick.test.ts`

> **Decisión de diseño a señalar (no en silencio):** `ARCHITECTURE.md §12` ubica `evaluate-candidate.ts` en `workflows/` como recurso **descubierto por Flue** (`defineWorkflow`). En Fase 1 **sin LLM no hay `session`**, así que en SP5 `evaluateCandidate` es una **función de orquestación dirigida por código** (alineada con "workflows dirigidos por código" del CLAUDE.md), invocada por el worker BullMQ. **Migración a Fase 2 (precisa, M4):** los pasos *post-veredicto* (`persistDecision → checkRiskForDecision → executeOrderSim → notify`) son reutilizables, pero `buildDeterministicVerdict` se sustituirá por `session.task(technical/fundamental)` + `session.skill('decision-protocol')`, y `session.*` **solo existe dentro de un handler `defineWorkflow`**. Por tanto, en Fase 2 los pasos post-veredicto se **extraen a una función auxiliar reutilizable** y el handler `defineWorkflow` la invoca tras obtener el veredicto del LLM — no es un simple "envoltorio". Validado por `kairos-plan-reviewer`: la decisión para Fase 1 es correcta (es la única opción sin `session`).

---

## Task 1: `getSignalById` — recargar la señal desde la cola

El worker recibe solo `signalId`; necesita reconstruir el `Signal` para `buildDeterministicVerdict`. Hoy `signals.ts` solo tiene `insertSignal`.

**Files:**
- Modify: `src/db/repositories/signals.ts`
- Test: `src/db/repositories/signals.test.ts`

**Interfaces:**
- Consumes: `query` de `../pool.ts`; tipo `Signal` de `../../lib/scanner/types.ts` (`{ strategyId, symbol, firedAt: Date, snapshot: IndicatorSnapshot }`); columnas `kairos.signals (id, strategy_id, symbol, fired_at, indicator_snapshot, status)`.
- Produces: `getSignalById(id: string): Promise<Signal | null>`.

- [ ] **Step 1: Escribir el test que falla**

> **M1 — el archivo ya existe.** `src/db/repositories/signals.test.ts` ya tiene `beforeAll(migrate + seedStrategies)`, un `afterAll` que borra `'TEST/USDT'` + `pool.end()`, y un `describe('signals repo', ...)`. **NO** dupliques `beforeAll`/`afterAll`/`pool.end()`. Haz exactamente dos cambios:
>
> 1. Extender el import existente: `import { insertSignal, getSignalById } from './signals.ts';`
> 2. Añadir **solo** este `describe` block (reusa `'TEST/USDT'`, que el `afterAll` existente ya limpia):

```ts
describe('getSignalById', () => {
  const snap15m = {
    byTimeframe: { '15m': { close: 100, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null, stochRsi: null, atrPct: 2, bbPosition: null, aboveVwap: null, obv: null, mfi: null, nearestSupport: null, nearestResistance: null, distToSupportPct: null } },
    mtfAlignment: 'aligned' as const, levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null },
  };

  test('reconstruye el Signal persistido (firedAt como Date, snapshot intacto)', async () => {
    const id = await insertSignal({ strategyId: 'pullback-alcista', symbol: 'TEST/USDT', firedAt: new Date('2026-03-07T00:00:00Z'), snapshot: snap15m });
    const loaded = await getSignalById(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.symbol).toBe('TEST/USDT');
    expect(loaded!.firedAt).toBeInstanceOf(Date);
    expect(loaded!.firedAt.toISOString()).toBe('2026-03-07T00:00:00.000Z');
    expect(loaded!.snapshot.byTimeframe['15m'].close).toBe(100);
    expect(loaded!.snapshot.mtfAlignment).toBe('aligned');
  });

  test('devuelve null si el id no existe', async () => {
    expect(await getSignalById('00000000000000000000000000')).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- signals`
Expected: FAIL con `getSignalById is not a function` (o de tipo: no exportado).

- [ ] **Step 3: Implementar `getSignalById`**

Añadir a `src/db/repositories/signals.ts`:

```ts
import type { Signal, IndicatorSnapshot } from '../../lib/scanner/types.ts';

interface SignalRow {
  strategy_id: string; symbol: string; fired_at: Date; indicator_snapshot: IndicatorSnapshot;
}

export async function getSignalById(id: string): Promise<Signal | null> {
  const rows = await query<SignalRow>(
    `SELECT strategy_id, symbol, fired_at, indicator_snapshot
     FROM kairos.signals WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { strategyId: r.strategy_id, symbol: r.symbol, firedAt: new Date(r.fired_at), snapshot: r.indicator_snapshot };
}
```

> Nota: `pg` ya parsea `jsonb` a objeto y `timestamptz` a `Date`; el `new Date(...)` defensivo normaliza si la columna fuese `text`. Importar `IndicatorSnapshot` solo si no rompe el import existente de `Signal`; si `types.ts` no exporta `IndicatorSnapshot`, tipar `indicator_snapshot` como `Signal['snapshot']`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm test -- signals`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/signals.ts src/db/repositories/signals.test.ts
git commit -m "feat: getSignalById recarga el Signal desde la cola (SP5)"
```

---

## Task 2: `evaluateCandidate` — orquestador determinista de entrada

El corazón de SP5. Recarga señal+estrategia, encadena el camino del dinero ya probado en SP3-e2e, y devuelve un resultado estructurado. Inyección de dependencias para testear ramas sin red ni manipular estado real (mismo patrón que `checkRiskForDecision(args, injected?)`).

**Files:**
- Create: `src/workflows/evaluate-candidate.ts`
- Test: `src/workflows/evaluate-candidate.test.ts`

**Interfaces:**
- Consumes: `getSignalById` (Task 1); `getStrategy(id): Promise<Strategy|null>` de `../db/repositories/strategies.ts`; `buildDeterministicVerdict(signal, strategy): Verdict` de `../lib/execution/verdict.ts`; `persistDecision(signalId, verdict, exec?): Promise<{id,verdict}>` de `../db/repositories/decisions.ts`; `checkRiskForDecision(args, injected?): Promise<RiskResult>` + tipo `GatheredState` de `../lib/execution/check-risk.ts`; `executeOrderSim(params): Promise<ExecutionResult>` de `../lib/execution/execute-order.ts`; `DEFAULT_SIM_PARAMS` de `../lib/execution/limits.ts`; `getMode(): TradingMode` de `../lib/mode.ts`; `sendWhatsApp(text, to?): Promise<{messageId}>` de `../notify/whatsapp.ts`.
- Produces:
  ```ts
  export type EvaluateOutcome =
    | { kind: 'skipped'; reason: string }
    | { kind: 'denied'; reason: string }
    | { kind: 'executed'; positionId: string | null; status: ExecutionResult['status'] }
    | { kind: 'not_found' };
  export interface EvaluateDeps { notify: (text: string, to?: string) => Promise<{ messageId: string | null }>; riskState?: GatheredState; }
  export function evaluateCandidate(signalId: string, deps?: Partial<EvaluateDeps>): Promise<EvaluateOutcome>;
  ```

- [ ] **Step 1: Escribir el test que falla (camino allow → executed)**

Crear `src/workflows/evaluate-candidate.test.ts`. Reusa el patrón de seed/cleanup de `sp3-e2e.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { pool, query } from '../db/pool.ts';
import { insertSignal } from '../db/repositories/signals.ts';
import { evaluateCandidate } from './evaluate-candidate.ts';
import type { Signal, Strategy, Features } from '../lib/scanner/types.ts';
import type { GatheredState } from '../lib/execution/check-risk.ts';

const SYMBOL = 'EVALBTC/USDT';
const STRATEGY_ID = 'eval-test-strategy';
const RISK_PARAMS = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 50, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const ALLOW_STATE: GatheredState = { equity: 100000, drawdownPct: 0, dailyPnl: 0, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, consecutiveLosses: 0 };

function features(close: number, atrPct: number): Features {
  return { close, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null, stochRsi: null, atrPct, bbPosition: null, aboveVwap: null, obv: null, mfi: null, nearestSupport: null, nearestResistance: null, distToSupportPct: null };
}
function enterSignal(): Signal {
  return { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-07T00:00:00Z'),
    snapshot: { byTimeframe: { '15m': features(100, 2) }, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
}

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, true, '15m', $2::text[], $3::jsonb, $4::jsonb, 2) ON CONFLICT (id) DO UPDATE SET enabled = true, risk_params = $4::jsonb`,
    [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }), JSON.stringify(RISK_PARAMS)],
  );
});
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]);
  await pool.end();
});

describe('evaluateCandidate', () => {
  test('señal de entrada con riesgo allow → ejecuta y notifica', async () => {
    const signalId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    const outcome = await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind === 'executed') {
      expect(outcome.status).toBe('filled');
      expect(outcome.positionId).not.toBeNull();
    }
    expect(notify).toHaveBeenCalledOnce();
  });

  test('idempotencia: reevaluar la misma señal → executed/duplicate, sin notificar de nuevo', async () => {
    const signalId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    const second = await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    expect(second.kind).toBe('executed');
    if (second.kind === 'executed') expect(second.status).toBe('duplicate');
    expect(notify).toHaveBeenCalledOnce(); // no re-notifica en duplicate
  });

  test('riesgo deny → no ejecuta, notifica el rechazo', async () => {
    const signalId = await insertSignal(enterSignal());
    const denyState: GatheredState = { ...ALLOW_STATE, dailyPnl: -99999, drawdownPct: 99 };
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    const outcome = await evaluateCandidate(signalId, { notify, riskState: denyState });
    expect(outcome.kind).toBe('denied');
    const orders = await query(`SELECT 1 FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id WHERE d.signal_id=$1`, [signalId]);
    expect(orders.length).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
  });

  test('signalId inexistente → not_found, no lanza', async () => {
    const outcome = await evaluateCandidate('00000000000000000000000000', { notify: vi.fn(async () => ({ messageId: null })) });
    expect(outcome.kind).toBe('not_found');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- evaluate-candidate`
Expected: FAIL con `Cannot find module './evaluate-candidate.ts'`.

- [ ] **Step 3: Implementar `evaluateCandidate`**

Crear `src/workflows/evaluate-candidate.ts`:

```ts
import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { persistDecision } from '../db/repositories/decisions.ts';
import { buildDeterministicVerdict } from '../lib/execution/verdict.ts';
import { checkRiskForDecision, type GatheredState } from '../lib/execution/check-risk.ts';
import { executeOrderSim } from '../lib/execution/execute-order.ts';
import { DEFAULT_SIM_PARAMS } from '../lib/execution/limits.ts';
import { getMode } from '../lib/mode.ts';
import { sendWhatsApp } from '../notify/whatsapp.ts';
import type { ExecutionResult } from '../lib/execution/types.ts';

export type EvaluateOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'executed'; positionId: string | null; status: ExecutionResult['status'] }
  | { kind: 'not_found' };

export interface EvaluateDeps {
  notify: (text: string, to?: string) => Promise<{ messageId: string | null }>;
  riskState?: GatheredState; // solo para tests (igual que checkRiskForDecision.injected)
}

const DEFAULT_DEPS: EvaluateDeps = { notify: sendWhatsApp };

// Orquestador determinista de entrada (sin LLM). Idempotente vía executeOrderSim (idempotency_key=signalId).
export async function evaluateCandidate(signalId: string, deps: Partial<EvaluateDeps> = {}): Promise<EvaluateOutcome> {
  const { notify, riskState } = { ...DEFAULT_DEPS, ...deps };
  const mode = getMode();

  const signal = await getSignalById(signalId);
  if (!signal) return { kind: 'not_found' };
  const strategy = await getStrategy(signal.strategyId);
  if (!strategy) return { kind: 'not_found' };

  const verdict = buildDeterministicVerdict(signal, strategy);
  if (verdict.action === 'skip') {
    return { kind: 'skipped', reason: verdict.reason ?? 'skip' };
  }

  const decision = await persistDecision(signalId, verdict);
  const risk = await checkRiskForDecision({ decision, strategy, symbol: signal.symbol, mode }, riskState);
  if (risk.result !== 'allow' || risk.adjustedSize === null) {
    await notify(`⛔ ${signal.symbol}: rechazado por riesgo — ${risk.reason}`);
    return { kind: 'denied', reason: risk.reason };
  }

  const exec = await executeOrderSim({
    signalId, symbol: signal.symbol, decision, riskResult: risk, strategy,
    referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode,
  });

  if (exec.status === 'filled') {
    // M3: fillPrice/qty son number|null en el tipo; en 'filled' nunca son null (fill dentro de la tx).
    const price = exec.fillPrice ?? 0;
    const qty = exec.qty ?? 0;
    await notify(`✅ ${signal.symbol}: entrada @ ${price} (${qty}) sl=${verdict.sl} tp=${verdict.tp}`);
  } else if (exec.status === 'pending_execution') {
    await notify(`⏳ ${signal.symbol}: ejecución pendiente (no asumida). idem=${exec.idempotencyKey}`);
  }
  return { kind: 'executed', positionId: exec.positionId, status: exec.status };
}
```

> `referencePrice = verdict.entry` mantiene la consistencia con el SP3-e2e y la reproducibilidad determinista en sim (el precio en vivo del ticker se incorpora cuando exista el ingester WS, §15 — fuera de SP5). En `duplicate` NO se notifica (la primera evaluación ya notificó).

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -- evaluate-candidate`
Expected: PASS (4 tests).

- [ ] **Step 5: Verificar typecheck**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/evaluate-candidate.ts src/workflows/evaluate-candidate.test.ts
git commit -m "feat: orquestador determinista evaluateCandidate (entrada, sin LLM) (SP5)"
```

---

## Task 3: Cola `evaluate-candidate` — parte pura + wrapper BullMQ

Separa la lógica testeable (construcción del job con `jobId = signalId`) del acoplamiento a Redis (que se valida en smoke test, no en la suite unit).

**Files:**
- Create: `src/lib/queue/connection.ts`
- Create: `src/lib/queue/evaluate-queue.ts`
- Test: `src/lib/queue/evaluate-queue.test.ts`

**Interfaces:**
- Consumes: `Queue` de `bullmq`, `IORedis` de `ioredis`; `process.env.REDIS_BULLMQ_URL`.
- Produces:
  ```ts
  export const EVALUATE_QUEUE = 'evaluate-candidate';
  export interface EvaluateJobData { signalId: string; }
  export interface EvaluateJobSpec { name: string; data: EvaluateJobData; opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean }; }
  export function buildEvaluateJob(signalId: string): EvaluateJobSpec; // puro
  export function enqueueEvaluateCandidate(signalId: string): Promise<void>; // wrapper BullMQ
  export const getBullConnection: () => IORedis; // de connection.ts
  ```

- [ ] **Step 1: Escribir el test que falla (parte pura)**

Crear `src/lib/queue/evaluate-queue.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildEvaluateJob, EVALUATE_QUEUE } from './evaluate-queue.ts';

describe('buildEvaluateJob', () => {
  test('usa jobId = signalId para deduplicar el encolado (idempotencia de cola)', () => {
    const spec = buildEvaluateJob('SIG123');
    expect(spec.data).toEqual({ signalId: 'SIG123' });
    expect(spec.opts.jobId).toBe('SIG123');
  });

  test('limpia jobs completados pero conserva los fallidos para inspección', () => {
    const spec = buildEvaluateJob('SIG123');
    expect(spec.opts.removeOnComplete).toBe(true);
    expect(spec.opts.removeOnFail).toBe(false);
  });

  test('el nombre de la cola es estable', () => {
    expect(EVALUATE_QUEUE).toBe('evaluate-candidate');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- evaluate-queue`
Expected: FAIL con `Cannot find module './evaluate-queue.ts'`.

- [ ] **Step 3: Implementar conexión + cola**

Crear `src/lib/queue/connection.ts`:

```ts
import IORedis from 'ioredis';

let conn: IORedis | null = null;

// Conexión singleton para BullMQ. maxRetriesPerRequest:null es requisito de BullMQ.
export function getBullConnection(): IORedis {
  if (conn) return conn;
  const url = process.env.REDIS_BULLMQ_URL;
  if (!url) throw new Error('REDIS_BULLMQ_URL no configurada');
  conn = new IORedis(url, { maxRetriesPerRequest: null });
  return conn;
}

export async function closeBullConnection(): Promise<void> {
  if (conn) { await conn.quit(); conn = null; }
}
```

Crear `src/lib/queue/evaluate-queue.ts`:

```ts
import { Queue } from 'bullmq';
import { getBullConnection } from './connection.ts';

export const EVALUATE_QUEUE = 'evaluate-candidate';

export interface EvaluateJobData { signalId: string; }
export interface EvaluateJobSpec {
  name: string;
  data: EvaluateJobData;
  opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
}

// Puro y testeable: jobId = signalId → BullMQ ignora duplicados con el mismo id.
export function buildEvaluateJob(signalId: string): EvaluateJobSpec {
  return { name: 'evaluate', data: { signalId }, opts: { jobId: signalId, removeOnComplete: true, removeOnFail: false } };
}

let queue: Queue<EvaluateJobData> | null = null;
function getQueue(): Queue<EvaluateJobData> {
  if (!queue) queue = new Queue(EVALUATE_QUEUE, { connection: getBullConnection() });
  return queue;
}

export async function enqueueEvaluateCandidate(signalId: string): Promise<void> {
  const spec = buildEvaluateJob(signalId);
  await getQueue().add(spec.name, spec.data, spec.opts);
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm test -- evaluate-queue`
Expected: PASS (3 tests).

- [ ] **Step 5: Verificar typecheck (confirma firmas reales de BullMQ)**

Run: `npm run typecheck`
Expected: sin errores. Si `Queue.add` o las opciones no coinciden, abrir los tipos en `node_modules/bullmq` y ajustar — no adivinar.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue/connection.ts src/lib/queue/evaluate-queue.ts src/lib/queue/evaluate-queue.test.ts
git commit -m "feat: cola BullMQ evaluate-candidate (jobId=signalId, conexión noeviction) (SP5)"
```

---

## Task 4: `runScanTick` — recorrer estrategias y encolar candidatos

Un tick del scanner: por cada estrategia activa y cada símbolo, corre `scanSymbol`; si dispara señal, encola el candidato. Inyección de `scan` y `enqueue` para testear sin Redis ni recalcular indicadores.

**Files:**
- Create: `src/lib/scanner/scan-tick.ts`
- Test: `src/lib/scanner/scan-tick.test.ts`

**Interfaces:**
- Consumes: `getEnabledStrategies(): Promise<Strategy[]>` de `../../db/repositories/strategies.ts`; `scanSymbol(strategy, symbol, asOf): Promise<string|null>` de `./scan-symbol.ts`; `enqueueEvaluateCandidate(signalId): Promise<void>` de `../queue/evaluate-queue.ts`.
- Produces:
  ```ts
  export interface ScanTickDeps {
    getStrategies: () => Promise<Strategy[]>;
    scan: (strategy: Strategy, symbol: string, asOf: Date) => Promise<string | null>;
    enqueue: (signalId: string) => Promise<void>;
    onError: (strategyId: string, symbol: string, err: unknown) => Promise<void>; // default audita a kairos.audit_log
  }
  export interface ScanTickResult { scanned: number; fired: number; enqueued: number; }
  export function runScanTick(asOf: Date, deps?: Partial<ScanTickDeps>): Promise<ScanTickResult>;
  ```

> **H2:** `onError` es inyectable para que los tests unitarios (todos los deps son `vi.fn()`, sin `migrate()`) no toquen Postgres en la rama de error. El default audita a la DB en producción.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/lib/scanner/scan-tick.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { runScanTick } from './scan-tick.ts';
import type { Strategy } from './types.ts';

function strat(id: string, symbols: string[]): Strategy {
  return { id, enabled: true, symbols, triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: {}, version: 1, skillName: null };
}

describe('runScanTick', () => {
  test('escanea cada símbolo de cada estrategia activa', async () => {
    const deps = {
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT']), strat('b', ['SOL/USDT'])],
      scan: vi.fn(async () => null),
      enqueue: vi.fn(async () => {}),
    };
    const res = await runScanTick(new Date('2026-03-07T00:00:00Z'), deps);
    expect(deps.scan).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ scanned: 3, fired: 0, enqueued: 0 });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  test('encola exactamente las señales que disparan', async () => {
    const scan = vi.fn(async (_s: Strategy, symbol: string) => (symbol === 'BTC/USDT' ? 'SIG-BTC' : null));
    const enqueue = vi.fn(async () => {});
    const res = await runScanTick(new Date('2026-03-07T00:00:00Z'), {
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT'])], scan, enqueue,
    });
    expect(res).toEqual({ scanned: 2, fired: 1, enqueued: 1 });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('SIG-BTC');
  });

  test('un fallo de scan en un símbolo no aborta el resto del tick (onError inyectado, sin DB)', async () => {
    const scan = vi.fn(async (_s: Strategy, symbol: string) => {
      if (symbol === 'BTC/USDT') throw new Error('boom');
      return 'SIG-ETH';
    });
    const enqueue = vi.fn(async () => {});
    const onError = vi.fn(async () => {});
    const res = await runScanTick(new Date('2026-03-07T00:00:00Z'), {
      getStrategies: async () => [strat('a', ['BTC/USDT', 'ETH/USDT'])], scan, enqueue, onError,
    });
    expect(res.scanned).toBe(2);
    expect(res.enqueued).toBe(1);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('SIG-ETH');
    expect(onError).toHaveBeenCalledExactlyOnceWith('a', 'BTC/USDT', expect.any(Error));
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- scan-tick`
Expected: FAIL con `Cannot find module './scan-tick.ts'`.

- [ ] **Step 3: Implementar `runScanTick`**

Crear `src/lib/scanner/scan-tick.ts`:

```ts
import { getEnabledStrategies } from '../../db/repositories/strategies.ts';
import { scanSymbol } from './scan-symbol.ts';
import { enqueueEvaluateCandidate } from '../queue/evaluate-queue.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import type { Strategy } from './types.ts';

export interface ScanTickDeps {
  getStrategies: () => Promise<Strategy[]>;
  scan: (strategy: Strategy, symbol: string, asOf: Date) => Promise<string | null>;
  enqueue: (signalId: string) => Promise<void>;
  onError: (strategyId: string, symbol: string, err: unknown) => Promise<void>;
}
export interface ScanTickResult { scanned: number; fired: number; enqueued: number; }

const DEFAULT_DEPS: ScanTickDeps = {
  getStrategies: getEnabledStrategies, scan: scanSymbol, enqueue: enqueueEvaluateCandidate,
  onError: async (strategyId, symbol, err) => {
    await appendAuditLog({ eventType: 'scan_error', actor: 'scan_tick', payload: { strategyId, symbol, error: err instanceof Error ? err.message : String(err) } });
  },
};

// Un tick determinista del scanner. Un fallo por símbolo se aísla (onError) y el tick continúa.
export async function runScanTick(asOf: Date, deps: Partial<ScanTickDeps> = {}): Promise<ScanTickResult> {
  const { getStrategies, scan, enqueue, onError } = { ...DEFAULT_DEPS, ...deps };
  const strategies = await getStrategies();
  let scanned = 0, fired = 0, enqueued = 0;

  for (const strategy of strategies) {
    for (const symbol of strategy.symbols) {
      scanned++;
      try {
        const signalId = await scan(strategy, symbol, asOf);
        if (!signalId) continue;
        fired++;
        await enqueue(signalId);
        enqueued++;
      } catch (err: unknown) {
        await onError(strategy.id, symbol, err);
      }
    }
  }
  return { scanned, fired, enqueued };
}
```

> **H2:** El default de `onError` audita a `kairos.audit_log` (toca DB en prod). Los tests unitarios inyectan `onError: vi.fn()` para no depender de Postgres en la rama de error.

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -- scan-tick`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/scanner/scan-tick.ts src/lib/scanner/scan-tick.test.ts
git commit -m "feat: runScanTick recorre estrategias activas y encola candidatos (SP5)"
```

---

## Task 5: Worker BullMQ + entrypoint del proceso

Cablea la cola al orquestador y agenda el scan repetible. Es wiring delgado sobre piezas ya testeadas; su validación es por **smoke test manual** contra el `docker-compose` (Postgres + Redis), no por la suite unit (que no levanta Redis).

**Files:**
- Create: `src/lib/queue/evaluate-worker.ts`
- Create: `src/worker.ts`
- Modify: `package.json` (script `worker`)

**Interfaces:**
- Consumes: `Worker` de `bullmq`; `getBullConnection` de `./connection.ts`; `EVALUATE_QUEUE`, `EvaluateJobData` de `./evaluate-queue.ts`; `evaluateCandidate` de `../../workflows/evaluate-candidate.ts`; `runScanTick` de `../scanner/scan-tick.ts`; `Queue` para el repeatable del scan.
- Produces: `startEvaluateWorker(): Worker`; entrypoint `src/worker.ts` que arranca worker + agenda `runScanTick` cada N minutos.

- [ ] **Step 1: Implementar el worker**

Crear `src/lib/queue/evaluate-worker.ts`:

```ts
import { Worker } from 'bullmq';
import { getBullConnection } from './connection.ts';
import { EVALUATE_QUEUE, type EvaluateJobData } from './evaluate-queue.ts';
import { evaluateCandidate } from '../../workflows/evaluate-candidate.ts';

// Worker BullMQ: procesa cada candidato encolado con el orquestador determinista.
export function startEvaluateWorker(): Worker<EvaluateJobData> {
  return new Worker<EvaluateJobData>(
    EVALUATE_QUEUE,
    async (job) => evaluateCandidate(job.data.signalId),
    { connection: getBullConnection(), concurrency: 1 },
  );
}
```

- [ ] **Step 2: Implementar el entrypoint del proceso**

Crear `src/worker.ts`:

```ts
import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import { getBullConnection } from './lib/queue/connection.ts';
import { startEvaluateWorker } from './lib/queue/evaluate-worker.ts';
import { runScanTick } from './lib/scanner/scan-tick.ts';

// L2: guarda contra valores no numéricos/no positivos en la env.
const parsedInterval = Number(process.env.SCAN_INTERVAL_MS);
const SCAN_INTERVAL_MS = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 15 * 60 * 1000;
const SCAN_QUEUE = 'scan-tick';

async function main(): Promise<void> {
  startEvaluateWorker();

  // H1: Worker se importa top-level (no dynamic import) para que tsc tipe el constructor.
  // Worker del scan: cada tick recorre estrategias y encola candidatos.
  new Worker(SCAN_QUEUE, async () => { await runScanTick(new Date()); }, { connection: getBullConnection(), concurrency: 1 });

  // M2: upsertJobScheduler es la API idempotente/nombrada de BullMQ v5 para repetibles
  // (reemplaza a Queue.add con { repeat }). Confirmar firma en node_modules/bullmq/dist/.../queue.d.ts.
  const scanQueue = new Queue(SCAN_QUEUE, { connection: getBullConnection() });
  await scanQueue.upsertJobScheduler('scan-tick', { every: SCAN_INTERVAL_MS }, { name: 'tick', data: {}, opts: { removeOnComplete: true } });

  process.stdout.write(`[worker] arriba: evaluate-candidate + scan cada ${SCAN_INTERVAL_MS}ms\n`);
}

main().catch((err) => { process.stderr.write(`[worker] fatal: ${err}\n`); process.exit(1); });
```

> `new Date()` en runtime es correcto aquí (proceso vivo, no workflow/script reanudable). Confirmar `upsertJobScheduler` contra los tipos reales de bullmq antes de fijar.

- [ ] **Step 3: Añadir el script `worker` a `package.json`**

En `scripts`, añadir:

```json
"worker": "node --experimental-strip-types src/worker.ts",
```

- [ ] **Step 4: Verificar typecheck**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 5: Smoke test manual (documentar resultado, no automatizar)**

```bash
docker compose up -d           # postgres + redis
npm run migrate                # crea esquema kairos
npm run seed                   # estrategias de ejemplo (enabled)
npm run worker                 # arranca workers
# En otra terminal, encolar una señal real o esperar al tick;
# verificar en Postgres: filas nuevas en kairos.signals / decisions / orders / positions (mode='sim').
```

Expected: el tick corre sin excepciones; una señal que dispara recorre decisión→riesgo→orden sim→notify. Registrar en el commit lo observado.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue/evaluate-worker.ts src/worker.ts package.json
git commit -m "feat: worker BullMQ + entrypoint que agenda el scan tick (SP5)"
```

---

## Self-Review

**1. Spec coverage (objetivo de Fase 1 — entrada del loop determinista vivo):**
- Scanner recorre estrategias y encola → Task 4 ✓
- Cola durable con idempotencia → Task 3 (`jobId=signalId`) ✓
- Orquestador veredicto→riesgo→ejecución→notify (sin LLM) → Task 2 ✓
- Recarga de estado desde DB (fuente de verdad) → Task 1 (`getSignalById`) + `getStrategy` existente ✓
- Worker + scheduler vivo → Task 5 ✓
- **Fuera de SP5 (→ SP6):** monitor de salida (SL/TP en vivo), reconciler al arranque, kill-switch caliente, bootstrap unificado con `app.ts`, dedup per-setup, listener `failed` con reintentos.

> **⚠️ RIESGO DE CAPITAL — corregido tras el review final de rama (era L1, estaba subestimado).** El idempotency key es `signalId`, y `scan()` es **stateless**: dispara una señal con un **ULID nuevo cada tick** mientras las condiciones de entrada se mantengan. Un setup que persiste varias velas (común en pullback/estructura) produce **una señal distinta por tick → distinto `idempotency_key` → órdenes/posiciones APILADAS para el mismo setup.** El único freno en SP5 son los topes de exposición del risk gate (`max_open_positions`, `max_symbol_exposure_pct`), que **acotan** el daño pero **no previenen** la entrada duplicada. Inofensivo en `sim`; **destructivo en testnet/live.** El lock Redis `lock:decision:{sym}:{strat}` (liberado al completar la evaluación) **NO** resuelve el re-firing *secuencial* entre ticks — solo la carrera concurrente in-flight. **SP6 (antes de testnet) debe añadir un dedup per-setup explícito:** p.ej. `UNIQUE` sobre posiciones abiertas `(strategy_id, symbol)`, o un guard "skip si ya hay posición abierta para (estrategia, símbolo)" en `evaluateCandidate` o `scanSymbol`.

**2. Placeholder scan:** sin TODOs ni "manejar errores apropiadamente" — cada paso trae código real. Los puntos a verificar contra doc real (BullMQ `add`/`repeat`, export de `IndicatorSnapshot`) están marcados explícitamente como verificación, no como placeholder.

**3. Type consistency:** `evaluateCandidate(signalId, deps?) → EvaluateOutcome`; `buildEvaluateJob(signalId) → EvaluateJobSpec` con `jobId`; `runScanTick(asOf, deps?) → ScanTickResult`; `getSignalById(id) → Signal | null`. `EvaluateDeps.riskState` se pasa como segundo arg de `checkRiskForDecision` (tipo `GatheredState`, consistente). `referencePrice = verdict.entry` igual que el SP3-e2e.

## Pendiente de revisión antes de ejecutar

Pasar este plan por el agente **`kairos-plan-reviewer`** (verifica contra `ARCHITECTURE.md` y la doc real de Flue), con foco en:
1. La desviación señalada: `evaluate-candidate` como función de orquestación (no `defineWorkflow` descubierto) mientras no haya LLM.
2. Que `jobId = signalId` sea dedup suficiente para Fase 1 (vs. el lock Redis `lock:decision:*` del §8/§5).
3. Idempotencia de extremo a extremo (cola + `executeOrderSim`) sin huecos.
