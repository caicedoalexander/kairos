# SP6 — Cierre de Fase 1 en `sim` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cerrar el loop determinista de Fase 1 — las posiciones que entra SP5 ahora salen por SL/TP en vivo, no se apilan por setup, y el proceso arranca y para limpio.

**Architecture:** un job repetible BullMQ `monitor-tick` lee la última vela de cada posición abierta y resuelve el bracket OCO con la lógica del backtester (`resolveBracket`), cerrando determinísticamente en una transacción. Un índice único parcial en `positions` garantiza una sola posición viva por `(strategy, symbol, mode)` (dedup race-safe), con un pre-check barato en `evaluateCandidate`. `worker.ts` gana un reconciler de arranque (auto-consistencia de DB, sin ccxt) y graceful shutdown.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), Postgres (esquema `kairos`, vía `pg`), BullMQ + ioredis, Vitest, Valibot. Spec: `docs/superpowers/specs/2026-06-28-sp6-cierre-fase1-design.md`.

## Global Constraints

- Imports ESM con extensión `.ts` explícita (p. ej. `import { x } from './y.ts'`).
- `pg` devuelve `numeric` como `string` → convertir con `Number()` siempre.
- Mutaciones multi-tabla van en `withTransaction(async (exec) => …)`; pasar `exec` a cada repo.
- El cierre por SL/TP es determinista e inmediato; **jamás** invoca un LLM (línea roja CLAUDE.md).
- La notificación es **best-effort**: un fallo de `notify` nunca propaga ni tumba el cierre/ejecución ya hechos. Usar `notifyBestEffort` (Task 4).
- Modo (`sim|testnet|live`) explícito; todo se aísla por `mode`. Default `sim`.
- Idempotencia: el cierre usa `UPDATE … WHERE status='open'`; el dedup usa un índice único parcial.
- Estilo: funciones <50 líneas, archivos <800, sin anidamiento >4, inmutabilidad, sin `console.log`, validación en límites. Español en comentarios/mensajes; identificadores en su forma.
- Tests de integración tocan el Postgres real del compose: requieren `docker compose up -d` y `DATABASE_URL`. Cobertura ≥ 80%.
- Correr un test puntual: `npx vitest run <ruta>`. Toda la suite: `npm test`. Tipos: `npm run typecheck`.
- **Córrelo de verdad antes de afirmar que pasa.** No declares verde sin ejecutar.

---

## File Structure

**Esquema / repos (modificar):**
- `src/db/schema.sql` — columnas `entry_fee`, `decision_id` (Task 1) e índice único parcial (Task 3).
- `src/db/repositories/positions.ts` — `openPosition` gana `entryFee`/`decisionId` (Task 1); `getOpenPositions`, `hasOpenPositionForSetup`, `closeOpenPosition` (Task 2).
- `src/db/repositories/orders.ts` — `closeBracketLegs` (Task 4); `findStuckEntryOrders`, `findOrphanedClosedLegs` (Task 7).
- `src/db/repositories/ohlcv-candles.ts` — `getLatestCandle` (Task 4).
- `src/lib/execution/execute-order.ts` — persiste `entryFee`/`decisionId` (Task 1); status `deduped` + catch del índice (Task 3).
- `src/lib/execution/types.ts` — `ExecutionResult.status` gana `'deduped'` (Task 3).
- `src/workflows/evaluate-candidate.ts` — pre-check dedup + mapeo `deduped`→`skipped` (Task 3); import de `notifyBestEffort` (Task 4).
- `src/worker.ts` — wiring monitor (Task 5), shutdown (Task 6), reconciler de arranque (Task 7).

**Nuevos:**
- `src/notify/best-effort.ts` — `notifyBestEffort` extraído y reutilizable (Task 4).
- `src/lib/monitor/close-position.ts` — `closePositionOnBracket` (Task 4).
- `src/lib/monitor/monitor-tick.ts` — `runMonitorTick` (Task 4).
- `src/lib/queue/shutdown.ts` — `createShutdown` (Task 6).
- `src/lib/reconcile/startup-reconcile.ts` — `runStartupReconcile` (Task 7).

**Tests (modificar por el índice — Task 3):** `positions.test.ts`, `evaluate-candidate.test.ts`, `execute-order.test.ts`.

---

## Task 1: Persistir `entry_fee` y `decision_id` en posiciones

El monitor necesita el fee de entrada (para el P&L de salida) y el link a la decisión (para cerrar las legs OCO y para el reconciler). Cambios aditivos: columnas opcionales + el `execute-order` las llena. Sin índice todavía → nada se rompe.

**Files:**
- Modify: `src/db/schema.sql` (tras la tabla `positions`, junto a las otras migraciones idempotentes)
- Modify: `src/db/repositories/positions.ts:5-29`
- Modify: `src/lib/execution/execute-order.ts:42-45`
- Test: `src/db/repositories/positions.test.ts` (nuevo test), `src/db/repositories/execute-order.test.ts` (nuevo test)

**Interfaces:**
- Consumes: `openPosition(p: OpenPositionInput, exec?)`, `withTransaction`, `appendAuditLog`.
- Produces: `OpenPositionInput` con `entryFee?: number` y `decisionId?: string`; columnas `kairos.positions.entry_fee numeric NOT NULL DEFAULT 0` y `kairos.positions.decision_id text` (FK a decisions). `executeOrderSim` persiste ambas.

- [ ] **Step 1: Añadir las columnas idempotentes al esquema**

En `src/db/schema.sql`, tras la definición de `kairos.positions` (después de la línea `);` que la cierra, ~línea 94), añadir:

```sql
-- SP6: fee de entrada para que el monitor calcule el P&L de salida; decision_id liga la posición
-- a su decisión/órdenes (cerrar legs OCO al salir + reconciler). Idempotente (ADD COLUMN IF NOT EXISTS).
ALTER TABLE kairos.positions ADD COLUMN IF NOT EXISTS entry_fee numeric NOT NULL DEFAULT 0;
ALTER TABLE kairos.positions ADD COLUMN IF NOT EXISTS decision_id text REFERENCES kairos.decisions(id);
```

- [ ] **Step 2: Escribir el test de persistencia (execute-order)**

En `src/db/repositories/execute-order.test.ts`, dentro de `describe('executeOrderSim', …)`, añadir:

```ts
  test('persiste entry_fee y decision_id en la posición', async () => {
    const { signalId, decision } = await seedSignalAndDecision();
    const r = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    const rows = await query<{ entry_fee: string; decision_id: string }>(
      `SELECT entry_fee, decision_id FROM kairos.positions WHERE id = $1`, [r.positionId],
    );
    expect(Number(rows[0].entry_fee)).toBe(r.fee);          // fee del fill de entrada
    expect(rows[0].decision_id).toBe(decision.id);
  });
```

- [ ] **Step 3: Correr el test y verlo fallar**

Run: `npx vitest run src/db/repositories/execute-order.test.ts`
Expected: FAIL — `entry_fee` es 0 (no se persiste) y `decision_id` es null.

- [ ] **Step 4: Extender `OpenPositionInput` y `openPosition`**

En `src/db/repositories/positions.ts`, reemplazar la interfaz `OpenPositionInput` (líneas 5-13) y la función `openPosition` (líneas 21-29):

```ts
export interface OpenPositionInput {
  symbol: string;
  entry: number;
  size: number;
  sl: number;
  tp: number;
  strategyId: string;
  mode: TradingMode;
  entryFee?: number;     // SP6: fee de entrada (default 0 para llamadores legacy/tests)
  decisionId?: string;   // SP6: link a la decisión (legs OCO + reconciler)
}

export async function openPosition(p: OpenPositionInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, entry_fee, decision_id)
     VALUES ($1, $2, 'long', $3, $4, $5, $6, 'open', $7, $8, $9, $10)`,
    [id, p.symbol, p.entry, p.size, p.sl, p.tp, p.strategyId, p.mode, p.entryFee ?? 0, p.decisionId ?? null],
  );
  return id;
}
```

- [ ] **Step 5: Pasar `entryFee`/`decisionId` desde `executeOrderSim`**

En `src/lib/execution/execute-order.ts`, reemplazar la llamada a `openPosition` (líneas 42-45):

```ts
    const positionId = await openPosition(
      { symbol: p.symbol, entry: fill.fillPrice, size: fill.qty, sl: p.decision.verdict.sl, tp: p.decision.verdict.tp,
        strategyId: p.strategy.id, mode: p.mode, entryFee: fill.fee, decisionId: p.decision.id },
      exec,
    );
```

- [ ] **Step 6: Correr el test y verlo pasar**

Run: `npx vitest run src/db/repositories/execute-order.test.ts`
Expected: PASS (incluido el test nuevo).

- [ ] **Step 7: Test de default en `openPosition` (sin los campos opcionales)**

En `src/db/repositories/positions.test.ts`, dentro de `describe('positions', …)`, añadir:

```ts
  test('openPosition sin entryFee/decisionId usa defaults (0 / null)', async () => {
    const id = await openPosition({ symbol: OTHER, entry: 10, size: 1, sl: 9, tp: 12, strategyId: STRATEGY_ID, mode: 'sim' });
    const rows = await query<{ entry_fee: string; decision_id: string | null }>('SELECT entry_fee, decision_id FROM kairos.positions WHERE id = $1', [id]);
    expect(Number(rows[0].entry_fee)).toBe(0);
    expect(rows[0].decision_id).toBeNull();
  });
```

- [ ] **Step 8: Correr positions + typecheck**

Run: `npx vitest run src/db/repositories/positions.test.ts && npm run typecheck`
Expected: PASS, sin errores de tipo.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.sql src/db/repositories/positions.ts src/lib/execution/execute-order.ts src/db/repositories/positions.test.ts src/db/repositories/execute-order.test.ts
git commit -m "feat: posiciones persisten entry_fee y decision_id (SP6 Task 1)"
```

---

## Task 2: Lecturas de posiciones para el monitor y el dedup

Tres lecturas que el monitor (Task 4) y el dedup (Task 3) necesitan. Todas respetan la invariante de una posición viva por setup (los tests usan setups distintos para no anticipar el índice).

**Files:**
- Modify: `src/db/repositories/positions.ts`
- Test: `src/db/repositories/positions.test.ts`

**Interfaces:**
- Consumes: `query`, `Executor`, `TradingMode`.
- Produces:
  - `interface OpenPosition { id; symbol; strategyId; decisionId: string | null; entry; size; sl; tp; entryFee; triggerTimeframe; mode; openedAt: Date }` (números `number`). `openedAt` lo usa el monitor para no salir en la misma vela en que entró (anti-look-ahead, §20).
  - `getOpenPositions(mode: TradingMode, exec?): Promise<OpenPosition[]>`.
  - `hasOpenPositionForSetup(strategyId: string, symbol: string, mode: TradingMode, exec?): Promise<boolean>`.
  - `closeOpenPosition(id: string, realizedPnl: number, closedAt: Date, exec?): Promise<boolean>` (true si cerró una fila `open`).

- [ ] **Step 1: Escribir los tests**

En `src/db/repositories/positions.test.ts`, añadir el import al inicio:

```ts
import { openPosition, closePosition, getExposure, getConsecutiveLosses, getDailyRealizedPnl, getOpenPositions, hasOpenPositionForSetup, closeOpenPosition } from './positions.ts';
```

Y dentro de `describe('positions', …)`:

```ts
  test('hasOpenPositionForSetup distingue setups y modos', async () => {
    await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    expect(await hasOpenPositionForSetup(STRATEGY_ID, SYMBOL, 'sim')).toBe(true);
    expect(await hasOpenPositionForSetup(STRATEGY_ID, OTHER, 'sim')).toBe(false);
    expect(await hasOpenPositionForSetup(STRATEGY_ID, SYMBOL, 'testnet')).toBe(false);
  });

  test('closeOpenPosition cierra solo si está open (idempotente)', async () => {
    const id = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });
    expect(await closeOpenPosition(id, -7, new Date('2026-03-09T00:00:00Z'))).toBe(true);
    expect(await closeOpenPosition(id, -7, new Date('2026-03-09T00:00:00Z'))).toBe(false); // ya cerrada
    const rows = await query<{ status: string; realized_pnl: string }>('SELECT status, realized_pnl FROM kairos.positions WHERE id = $1', [id]);
    expect(rows[0].status).toBe('closed');
    expect(Number(rows[0].realized_pnl)).toBe(-7);
  });

  test('getOpenPositions trae datos del monitor (entryFee, triggerTimeframe) y aísla por modo', async () => {
    await openPosition({ symbol: SYMBOL, entry: 100, size: 2, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim', entryFee: 0.5 });
    const open = await getOpenPositions('sim');
    const mine = open.find((p) => p.symbol === SYMBOL && p.strategyId === STRATEGY_ID);
    expect(mine).toBeDefined();
    expect(mine!.entryFee).toBe(0.5);
    expect(mine!.triggerTimeframe).toBe('15m');     // de trigger_config de la estrategia
    expect(typeof mine!.entry).toBe('number');
    expect(mine!.openedAt).toBeInstanceOf(Date);
    expect((await getOpenPositions('testnet')).some((p) => p.symbol === SYMBOL)).toBe(false);
  });
```

Nota: la estrategia semilla del test (`positions-test-strategy`) tiene `trigger_config = '{}'`; para que `getOpenPositions` devuelva `triggerTimeframe='15m'` hay que sembrarla con un `trigger_config` real. En el `beforeAll` (líneas 12-16), cambiar el `trigger_config` insertado a:

```ts
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO UPDATE SET trigger_config = $3::jsonb`,
    [STRATEGY_ID, `{${SYMBOL},${OTHER}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } })],
```

Y añadir un `afterEach` para que las posiciones abiertas no se acumulen entre tests (necesario en Task 3, inocuo ahora):

```ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
// …
afterEach(async () => {
  await query('DELETE FROM kairos.positions WHERE symbol IN ($1, $2)', [SYMBOL, OTHER]);
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/db/repositories/positions.test.ts`
Expected: FAIL — `getOpenPositions`/`hasOpenPositionForSetup`/`closeOpenPosition` no existen.

- [ ] **Step 3: Implementar las tres lecturas**

En `src/db/repositories/positions.ts`, añadir al final del archivo:

```ts
export interface OpenPosition {
  id: string;
  symbol: string;
  strategyId: string;
  decisionId: string | null;
  entry: number;
  size: number;
  sl: number;
  tp: number;
  entryFee: number;
  triggerTimeframe: string;
  mode: TradingMode;
  openedAt: Date;        // SP6: límite inferior de velas que el monitor puede resolver (anti-look-ahead)
}

interface OpenPositionRow {
  id: string; symbol: string; strategy_id: string; decision_id: string | null;
  entry: string; size: string; sl: string; tp: string; entry_fee: string;
  trigger_timeframe: string; mode: string; opened_at: Date;
}

// Posiciones abiertas del modo, con el trigger-TF de su estrategia (lo necesita el monitor para
// leer la última vela) y opened_at (para no salir en la vela de entrada). Filtra sl/tp NULL (sin
// bracket no hay nada que resolver) y estrategias sin trigger-TF (no se podrían monitorizar).
export async function getOpenPositions(mode: TradingMode, exec: Executor = query): Promise<OpenPosition[]> {
  const rows = await exec<OpenPositionRow>(
    `SELECT p.id, p.symbol, p.strategy_id, p.decision_id, p.entry, p.size, p.sl, p.tp, p.entry_fee, p.mode, p.opened_at,
            s.trigger_config->'timeframes'->>'trigger' AS trigger_timeframe
       FROM kairos.positions p
       JOIN kairos.strategies s ON s.id = p.strategy_id
      WHERE p.status = 'open' AND p.mode = $1 AND p.sl IS NOT NULL AND p.tp IS NOT NULL
        AND s.trigger_config->'timeframes'->>'trigger' IS NOT NULL`,
    [mode],
  );
  return rows.map((r) => ({
    id: r.id, symbol: r.symbol, strategyId: r.strategy_id, decisionId: r.decision_id,
    entry: Number(r.entry), size: Number(r.size), sl: Number(r.sl), tp: Number(r.tp),
    entryFee: Number(r.entry_fee), triggerTimeframe: r.trigger_timeframe, mode: r.mode as TradingMode,
    openedAt: r.opened_at,
  }));
}

// Pre-check de dedup per-setup: ¿hay ya una posición viva para (strategy, symbol, mode)?
export async function hasOpenPositionForSetup(
  strategyId: string, symbol: string, mode: TradingMode, exec: Executor = query,
): Promise<boolean> {
  const rows = await exec(
    `SELECT 1 FROM kairos.positions WHERE strategy_id = $1 AND symbol = $2 AND mode = $3 AND status = 'open' LIMIT 1`,
    [strategyId, symbol, mode],
  );
  return rows.length > 0;
}

// Cierre idempotente: solo aplica si sigue 'open'. Devuelve true si cerró la fila.
export async function closeOpenPosition(
  id: string, realizedPnl: number, closedAt: Date, exec: Executor = query,
): Promise<boolean> {
  const rows = await exec(
    `UPDATE kairos.positions SET status = 'closed', realized_pnl = $2, closed_at = $3
      WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, realizedPnl, closedAt],
  );
  return rows.length > 0;
}
```

Además, anotar la función `closePosition` existente (línea ~31) como deprecada para que nadie la use en vez del cierre que también cierra las legs OCO (evita legs huérfanas). Añadir encima de `export async function closePosition`:

```ts
/** @deprecated SP6: usa closeOpenPosition (idempotente) + closeBracketLegs para no dejar legs OCO huérfanas. */
```

- [ ] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/db/repositories/positions.test.ts && npm run typecheck`
Expected: PASS, sin errores de tipo.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/positions.ts src/db/repositories/positions.test.ts
git commit -m "feat: getOpenPositions, hasOpenPositionForSetup, closeOpenPosition (SP6 Task 2)"
```

---

## Task 3: Dedup per-setup (índice único parcial + status `deduped` + pre-check)

Introduce la invariante "una posición viva por setup" a nivel DB (race-safe) y la maneja en `executeOrderSim` (status `deduped`) y `evaluateCandidate` (pre-check → `skipped`). El índice rompe tests que reusan un setup y acumulan posiciones; esta tarea los reconcilia (afterEach + setups distintos).

**Files:**
- Modify: `src/db/schema.sql` (índice único parcial)
- Modify: `src/lib/execution/types.ts:72-80` (status `deduped`)
- Modify: `src/lib/execution/execute-order.ts` (catch del índice)
- Modify: `src/workflows/evaluate-candidate.ts` (pre-check + mapeo)
- Test: `src/db/repositories/execute-order.test.ts`, `src/workflows/evaluate-candidate.test.ts`, `src/db/repositories/positions.test.ts`

**Interfaces:**
- Consumes: `hasOpenPositionForSetup` (Task 2), `openPosition` (lanza al violar el índice).
- Produces: `ExecutionResult.status` incluye `'deduped'`; `evaluateCandidate` retorna `{ kind: 'skipped', reason }` ante dedup.

- [ ] **Step 1: Añadir el índice único parcial al esquema**

En `src/db/schema.sql`, tras los `ALTER TABLE kairos.positions` de Task 1, añadir:

```sql
-- SP6: dedup per-setup. Una sola posición viva por (strategy, symbol, mode). Race-safe por
-- construcción (igual que UNIQUE(idempotency_key) en orders). Parcial: solo aplica a 'open'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_open_setup
  ON kairos.positions (strategy_id, symbol, mode) WHERE status = 'open';
```

- [ ] **Step 2: Reconciliar `positions.test.ts` con la invariante**

El test de exposición abre dos posiciones del **mismo** setup; con el índice eso ya no es válido. Usar dos estrategias para las dos posiciones de `SYMBOL`. En `src/db/repositories/positions.test.ts`:

Añadir una segunda estrategia en `beforeAll` (tras el primer INSERT):

```ts
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID_2, `{${SYMBOL},${OTHER}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } })],
  );
```

Declarar `const STRATEGY_ID_2 = 'positions-test-strategy-2';` junto a `STRATEGY_ID`. En `afterAll`, borrar también esa estrategia: cambiar la línea de borrado de strategies por `await query('DELETE FROM kairos.strategies WHERE id IN ($1, $2)', [STRATEGY_ID, STRATEGY_ID_2]);`.

Reescribir el test de exposición para usar dos estrategias en `SYMBOL`:

```ts
  test('getExposure suma el notional del símbolo (entry*size) y aísla por símbolo', async () => {
    await openPosition({ symbol: SYMBOL, entry: 100, size: 2, sl: 95, tp: 110, strategyId: STRATEGY_ID, mode: 'sim' });   // 200
    await openPosition({ symbol: SYMBOL, entry: 100, size: 3, sl: 95, tp: 110, strategyId: STRATEGY_ID_2, mode: 'sim' }); // 300 (otra estrategia → no viola el índice)
    await openPosition({ symbol: OTHER, entry: 50, size: 1, sl: 48, tp: 55, strategyId: STRATEGY_ID, mode: 'sim' });      // 50
    const exp = await getExposure('sim', SYMBOL);
    expect(exp.openNotionalSymbol).toBe(500);
    expect(exp.openNotionalTotal).toBeGreaterThanOrEqual(550);
    expect(exp.openPositionsCount).toBeGreaterThanOrEqual(3);
  });
```

(El `afterEach` de Task 2 ya limpia posiciones entre tests, así que `closePosition`/`getConsecutiveLosses` siguen funcionando con un solo `open` por setup a la vez.)

- [ ] **Step 3: Añadir el status `deduped` al tipo**

En `src/lib/execution/types.ts`, cambiar la unión de `ExecutionResult.status` (línea 73):

```ts
  status: 'filled' | 'pending_execution' | 'duplicate' | 'deduped';
```

- [ ] **Step 4: Test del path `deduped` (carrera de dos señales del mismo setup)**

En `src/db/repositories/execute-order.test.ts`, añadir `afterEach` (importarlo) para que los tests no acumulen posiciones abiertas del mismo setup:

```ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
// …
afterEach(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id = o.decision_id JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol = $1`, [SYMBOL]);
});
```

Y el test de dedup:

```ts
  test('dedup per-setup: segunda señal del mismo setup → deduped, sin segunda posición', async () => {
    const a = await seedSignalAndDecision();
    const b = await seedSignalAndDecision();   // mismo (strategy, symbol, mode), distinta señal/decisión
    const first = await executeOrderSim({ signalId: a.signalId, symbol: SYMBOL, decision: a.decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    const second = await executeOrderSim({ signalId: b.signalId, symbol: SYMBOL, decision: b.decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(first.status).toBe('filled');
    expect(second.status).toBe('deduped');
    expect(second.positionId).toBeNull();
    const cnt = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol = $1 AND status = 'open' AND mode = 'sim'`, [SYMBOL]);
    expect(Number(cnt[0].n)).toBe(1);
  });
```

- [ ] **Step 5: Correr y ver fallar**

Run: `npx vitest run src/db/repositories/execute-order.test.ts`
Expected: FAIL — el segundo execute lanza la violación 23505 (aún sin capturar) en vez de devolver `deduped`.

- [ ] **Step 6: Capturar la violación del índice en `executeOrderSim`**

En `src/lib/execution/execute-order.ts`, añadir el helper tras los imports y envolver `withTransaction`:

```ts
// La violación del índice parcial idx_positions_open_setup significa "ya hay una posición viva
// para este setup" (carrera con otra señal): se trata como deduped, no como crash.
function isOpenSetupViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: string }).code === '23505'
    && (err as { constraint?: string }).constraint === 'idx_positions_open_setup';
}
```

Cambiar el cuerpo de `executeOrderSim`: el `return withTransaction(…)` pasa a estar dentro de un `try`:

```ts
  try {
    return await withTransaction(async (exec) => {
      // … cuerpo idéntico al actual (claim, fill, openPosition, legs, audit, return filled/duplicate) …
    });
  } catch (err: unknown) {
    if (isOpenSetupViolation(err)) {
      return { status: 'deduped', idempotencyKey: idem, orderId: '', positionId: null, fillPrice: null, qty: null, fee: null };
    }
    throw err;
  }
```

(`orderId: ''` porque la transacción se revirtió: no quedó orden persistida. El consumidor mapea `deduped`→`skipped` y no usa `orderId`.)

- [ ] **Step 7: Correr execute-order y ver pasar**

Run: `npx vitest run src/db/repositories/execute-order.test.ts`
Expected: PASS (incluido el test de idempotencia, que sigue dando `duplicate` por el claim antes de tocar `openPosition`).

- [ ] **Step 8: Pre-check de dedup + mapeo en `evaluateCandidate`**

En `src/workflows/evaluate-candidate.ts`:

Añadir el import:

```ts
import { hasOpenPositionForSetup } from '../db/repositories/positions.ts';
```

Tras la carga de `strategy` (línea 49, antes de `buildDeterministicVerdict`), añadir el pre-check:

```ts
  // Dedup per-setup (pre-check barato; el índice parcial es la red ante carreras).
  if (await hasOpenPositionForSetup(signal.strategyId, signal.symbol, mode)) {
    return { kind: 'skipped', reason: 'dedup: posición abierta para el setup' };
  }
```

Tras la llamada a `executeOrderSim` (antes del `if (exec.status === 'filled')`), mapear el path de carrera:

```ts
  if (exec.status === 'deduped') {
    return { kind: 'skipped', reason: 'dedup: carrera con otra señal del mismo setup' };
  }
```

- [ ] **Step 9: Reconciliar `evaluate-candidate.test.ts` con el dedup**

En `src/workflows/evaluate-candidate.test.ts`:

Importar `afterEach` y añadir limpieza entre tests (las tres pruebas que crean posiciones comparten el mismo setup):

```ts
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
// …
afterEach(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
```

Reemplazar el test `'idempotencia: reevaluar la misma señal…'` (ya no aplica: con el pre-check, una segunda señal del setup se salta antes de llegar al claim) por un test de dedup. El path `duplicate` por `idempotency_key` queda cubierto en `execute-order.test.ts` y `sp3-e2e.test.ts`:

```ts
  test('dedup: segunda señal del mismo setup con posición abierta → skipped, sin segunda posición', async () => {
    const firstId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    const first = await evaluateCandidate(firstId, { notify, riskState: ALLOW_STATE });
    expect(first.kind).toBe('executed');

    const secondId = await insertSignal(enterSignal());   // mismo setup, distinta señal
    const second = await evaluateCandidate(secondId, { notify, riskState: ALLOW_STATE });
    expect(second.kind).toBe('skipped');
    if (second.kind === 'skipped') expect(second.reason).toContain('dedup');

    const cnt = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol=$1 AND status='open'`, [SYMBOL]);
    expect(Number(cnt[0].n)).toBe(1);
  });
```

- [ ] **Step 10: Correr los tres archivos afectados y ver pasar**

Run: `npx vitest run src/db/repositories/execute-order.test.ts src/workflows/evaluate-candidate.test.ts src/db/repositories/positions.test.ts`
Expected: PASS en los tres.

- [ ] **Step 11: Suite completa + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS, sin regresiones (el índice no rompe `sp3-e2e` ni `check-risk-wrapper`: crean una sola posición por setup).

- [ ] **Step 12: Commit**

```bash
git add src/db/schema.sql src/lib/execution/types.ts src/lib/execution/execute-order.ts src/workflows/evaluate-candidate.ts src/db/repositories/execute-order.test.ts src/workflows/evaluate-candidate.test.ts src/db/repositories/positions.test.ts
git commit -m "feat: dedup per-setup (índice único parcial + status deduped + pre-check) (SP6 Task 3)"
```

---

## Task 4: Monitor de salida (`monitor-tick`)

La lógica viva del monitor: por cada posición abierta, leer la última vela y resolver el bracket; al tocar SL/TP, cerrar en una transacción y notificar best-effort. Reusa `resolveBracket` (backtester). Extrae `notifyBestEffort` a un módulo compartido (DRY con SP5).

**Files:**
- Create: `src/notify/best-effort.ts`
- Create: `src/lib/monitor/close-position.ts`
- Create: `src/lib/monitor/monitor-tick.ts`
- Modify: `src/db/repositories/ohlcv-candles.ts` (getLatestCandle)
- Modify: `src/db/repositories/orders.ts` (closeBracketLegs)
- Modify: `src/workflows/evaluate-candidate.ts` (usar notifyBestEffort compartido)
- Test: `src/notify/best-effort.test.ts`, `src/db/repositories/ohlcv-candles.test.ts`, `src/lib/monitor/close-position.test.ts`, `src/lib/monitor/monitor-tick.test.ts`

**Interfaces:**
- Consumes: `getOpenPositions`, `closeOpenPosition`, `OpenPosition` (Task 2); `resolveBracket`, `BracketResolution`, `BarOHLC`, `SimParams`; `DEFAULT_SIM_PARAMS`; `getMode`; `appendAuditLog`; `sendWhatsApp`.
- Produces:
  - `notifyBestEffort(notify, text, actor): Promise<void>`.
  - `getLatestCandle(symbol, timeframe, asOf, minOpenTime?): Promise<OhlcvRow | null>` (`minOpenTime` excluye velas `<=` ese instante: anti-look-ahead).
  - `closeBracketLegs(decisionId, hitPurpose: 'sl'|'tp', exec?): Promise<void>`.
  - `closePositionOnBracket(position: OpenPosition, resolution: BracketResolution, closedAt: Date): Promise<boolean>`.
  - `runMonitorTick(asOf: Date, deps?): Promise<{ checked: number; closed: number }>` con `MonitorTickDeps` inyectables.

- [ ] **Step 1: Test de `notifyBestEffort`**

Crear `src/notify/best-effort.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { notifyBestEffort } from './best-effort.ts';

vi.mock('../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn(async () => 'id') }));
import { appendAuditLog } from '../db/repositories/audit-log.ts';

describe('notifyBestEffort', () => {
  test('éxito: llama notify, no audita', async () => {
    const notify = vi.fn(async () => ({ messageId: 'm1' }));
    await notifyBestEffort(notify, 'hola', 'monitor');
    expect(notify).toHaveBeenCalledOnce();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  test('fallo de notify: audita notify_failed con el actor, no lanza', async () => {
    const notify = vi.fn(async () => { throw new Error('Evolution caído'); });
    await expect(notifyBestEffort(notify, 'hola', 'monitor')).resolves.toBeUndefined();
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'notify_failed', actor: 'monitor' }));
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/notify/best-effort.test.ts`
Expected: FAIL — `best-effort.ts` no existe.

- [ ] **Step 3: Crear `notifyBestEffort` y reusarlo en evaluate-candidate**

Crear `src/notify/best-effort.ts`:

```ts
import { appendAuditLog } from '../db/repositories/audit-log.ts';

type Notify = (text: string) => Promise<{ messageId: string | null }>;

// La notificación es una capa separada best-effort (§principio rector): un fallo de notify NUNCA
// debe propagarse y tumbar el flujo tras mover dinero. Se audita y se sigue.
export async function notifyBestEffort(notify: Notify, text: string, actor: string): Promise<void> {
  try {
    await notify(text);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await appendAuditLog({ eventType: 'notify_failed', actor, payload: { text, error } });
    } catch {
      process.stderr.write(`[${actor}] notify y audit fallaron: ${error}\n`);
    }
  }
}
```

En `src/workflows/evaluate-candidate.ts`, borrar la función local `notifyBestEffort` (líneas 26-39) y su uso del import de `appendAuditLog` si queda sin usar; añadir el import:

```ts
import { notifyBestEffort } from '../notify/best-effort.ts';
```

Actualizar las tres llamadas para pasar el actor: `notifyBestEffort(notify, '…', 'evaluate-candidate')`.

- [ ] **Step 4: Correr best-effort + evaluate-candidate y ver pasar**

Run: `npx vitest run src/notify/best-effort.test.ts src/workflows/evaluate-candidate.test.ts && npm run typecheck`
Expected: PASS, sin errores de tipo.

- [ ] **Step 5: Commit parcial (extracción)**

```bash
git add src/notify/best-effort.ts src/notify/best-effort.test.ts src/workflows/evaluate-candidate.ts
git commit -m "refactor: extrae notifyBestEffort a notify/best-effort.ts (SP6 Task 4)"
```

- [ ] **Step 6: Test de `getLatestCandle`**

En `src/db/repositories/ohlcv-candles.test.ts`, añadir el import de `getLatestCandle` y un test (usar un símbolo propio para no chocar con otros tests):

```ts
  test('getLatestCandle devuelve la vela más reciente <= asOf', async () => {
    const sym = 'LATESTBTC/USDT';
    await upsertCandles([
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-03-10T00:00:00Z'), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { symbol: sym, timeframe: '15m', openTime: new Date('2026-03-10T00:15:00Z'), o: 1.5, h: 3, l: 1, c: 2.5, v: 12 },
    ]);
    const bar = await getLatestCandle(sym, '15m', new Date('2026-03-10T00:20:00Z'));
    expect(bar?.openTime.toISOString()).toBe('2026-03-10T00:15:00.000Z');
    expect(bar?.c).toBe(2.5);
    expect(await getLatestCandle(sym, '15m', new Date('2026-03-09T00:00:00Z'))).toBeNull();
    // minOpenTime excluye velas <= ese instante (anti-look-ahead: no resolver la vela de entrada).
    expect((await getLatestCandle(sym, '15m', new Date('2026-03-10T00:20:00Z'), new Date('2026-03-10T00:00:00Z')))?.openTime.toISOString()).toBe('2026-03-10T00:15:00.000Z');
    expect(await getLatestCandle(sym, '15m', new Date('2026-03-10T00:20:00Z'), new Date('2026-03-10T00:15:00Z'))).toBeNull();
    await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [sym]);
  });
```

(Asegurar que `getLatestCandle` esté en el import y que `query` esté importado en el archivo de test.)

- [ ] **Step 7: Implementar `getLatestCandle`**

En `src/db/repositories/ohlcv-candles.ts`, añadir tras `getLatestOpenTime`:

```ts
export async function getLatestCandle(
  symbol: string, timeframe: string, asOf: Date, minOpenTime?: Date,
): Promise<OhlcvRow | null> {
  const rows = await query<{
    symbol: string; timeframe: string; open_time: Date; o: string; h: string; l: string; c: string; v: string;
  }>(
    `SELECT symbol, timeframe, open_time, o, h, l, c, v
       FROM kairos.ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2 AND open_time <= $3
        AND ($4::timestamptz IS NULL OR open_time > $4)
      ORDER BY open_time DESC LIMIT 1`,
    [symbol, timeframe, asOf, minOpenTime ?? null],
  );
  const r = rows[0];
  if (!r) return null;
  return { symbol: r.symbol, timeframe: r.timeframe, openTime: r.open_time,
    o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) };
}
```

- [ ] **Step 8: Test de `closeBracketLegs`**

En `src/db/repositories/orders.test.ts` (revisar su `beforeAll`/`afterAll`; añadir lo necesario), un test que inserta una entry + dos legs y las cierra:

```ts
  test('closeBracketLegs marca la leg tocada filled y la otra canceled', async () => {
    // Sembrar decision (requiere strategy+signal); reusar el helper del archivo o insertar inline.
    const decisionId = await seedDecisionForOrders();   // helper local que devuelve un decision.id
    const entry = await claimEntryOrder({ idempotencyKey: `${decisionId}:entry`, decisionId, size: 1, mode: 'sim' });
    await insertBracketLeg({ idempotencyKey: `${decisionId}:sl`, decisionId, size: 1, purpose: 'sl', parentId: entry!.id, mode: 'sim' });
    await insertBracketLeg({ idempotencyKey: `${decisionId}:tp`, decisionId, size: 1, purpose: 'tp', parentId: entry!.id, mode: 'sim' });

    await closeBracketLegs(decisionId, 'sl');

    const rows = await query<{ purpose: string; status: string }>(`SELECT purpose, status FROM kairos.orders WHERE decision_id = $1 AND purpose IN ('sl','tp')`, [decisionId]);
    const byPurpose = Object.fromEntries(rows.map((r) => [r.purpose, r.status]));
    expect(byPurpose.sl).toBe('filled');
    expect(byPurpose.tp).toBe('canceled');
  });
```

Si `orders.test.ts` no tiene un helper para sembrar una decisión, añadir uno (`seedDecisionForOrders`) que inserte strategy+signal+decision y devuelva el `decision.id`, replicando el patrón de `execute-order.test.ts` (`seedSignalAndDecision`) y limpiando en `afterAll`. Importar `closeBracketLegs`, `claimEntryOrder`, `insertBracketLeg`.

- [ ] **Step 9: Implementar `closeBracketLegs`**

En `src/db/repositories/orders.ts`, añadir al final:

```ts
// Cierra las legs OCO de una decisión al resolver el bracket: la tocada → filled, la otra → canceled.
export async function closeBracketLegs(
  decisionId: string, hitPurpose: 'sl' | 'tp', exec: Executor = query,
): Promise<void> {
  await exec(
    `UPDATE kairos.orders
        SET status = CASE WHEN purpose = $2 THEN 'filled' ELSE 'canceled' END
      WHERE decision_id = $1 AND purpose IN ('sl', 'tp')`,
    [decisionId, hitPurpose],
  );
}
```

- [ ] **Step 10: Correr ohlcv + orders y ver pasar**

Run: `npx vitest run src/db/repositories/ohlcv-candles.test.ts src/db/repositories/orders.test.ts`
Expected: PASS.

- [ ] **Step 11: Test de `closePositionOnBracket` (integración)**

Crear `src/lib/monitor/close-position.test.ts`. Abre una posición real vía `executeOrderSim` (que linka decision_id y crea legs pending), la cierra por bracket y verifica: posición closed con el P&L, legs cerradas, audit `position_closed_sim`, e idempotencia.

```ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { persistDecision } from '../../db/repositories/decisions.ts';
import { executeOrderSim } from '../execution/execute-order.ts';
import { getOpenPositions } from '../../db/repositories/positions.ts';
import { resolveBracket } from '../execution/bracket.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { closePositionOnBracket } from './close-position.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { RiskResult } from '../execution/types.ts';

const SYMBOL = 'CLOSEBTC/USDT';
const STRATEGY_ID = 'close-test-strategy';
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: {}, version: 1, skillName: null };
const RISK_ALLOW: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 1, notional: 100, limitsSnapshot: {} };

async function openOne() {
  // trigger_config con timeframes reales: getOpenPositions excluye estrategias sin trigger-TF.
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO UPDATE SET trigger_config = $3::jsonb`, [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } })]);
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-11T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('closePositionOnBracket', () => {
  test('cierra la posición, cierra las legs y audita; idempotente', async () => {
    await openOne();
    const pos = (await getOpenPositions('sim')).find((p) => p.symbol === SYMBOL)!;
    const tpBar = { open: pos.tp, high: pos.tp + 1, low: pos.entry, close: pos.tp };
    const resolution = resolveBracket(pos, tpBar, DEFAULT_SIM_PARAMS)!;
    expect(resolution.hitType).toBe('tp');

    const closed = await closePositionOnBracket(pos, resolution, new Date('2026-03-11T01:00:00Z'));
    expect(closed).toBe(true);

    const prow = await query<{ status: string; realized_pnl: string }>(`SELECT status, realized_pnl FROM kairos.positions WHERE id=$1`, [pos.id]);
    expect(prow[0].status).toBe('closed');
    expect(Number(prow[0].realized_pnl)).toBeCloseTo(resolution.realizedPnl, 6);
    const legs = await query<{ status: string }>(`SELECT status FROM kairos.orders WHERE decision_id=$1 AND purpose IN ('sl','tp')`, [pos.decisionId]);
    expect(legs.every((l) => l.status !== 'pending')).toBe(true);
    const audit = await query(`SELECT 1 FROM kairos.audit_log WHERE event_type='position_closed_sim' AND payload->>'positionId'=$1`, [pos.id]);
    expect(audit.length).toBe(1);

    expect(await closePositionOnBracket(pos, resolution, new Date('2026-03-11T02:00:00Z'))).toBe(false); // ya cerrada
  });
});
```

- [ ] **Step 12: Correr y ver fallar**

Run: `npx vitest run src/lib/monitor/close-position.test.ts`
Expected: FAIL — `close-position.ts` no existe.

- [ ] **Step 13: Implementar `closePositionOnBracket`**

Crear `src/lib/monitor/close-position.ts`:

```ts
import { withTransaction } from '../../db/pool.ts';
import { closeOpenPosition, type OpenPosition } from '../../db/repositories/positions.ts';
import { closeBracketLegs } from '../../db/repositories/orders.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import type { BracketResolution } from '../execution/types.ts';

// Cierre determinista por bracket en una transacción: cierra la posición (idempotente), cierra las
// legs OCO de su decisión y audita. Devuelve false si otra corrida del tick ya la cerró.
export async function closePositionOnBracket(
  position: OpenPosition, resolution: BracketResolution, closedAt: Date,
): Promise<boolean> {
  return withTransaction(async (exec) => {
    const closed = await closeOpenPosition(position.id, resolution.realizedPnl, closedAt, exec);
    if (!closed) return false;
    if (position.decisionId) await closeBracketLegs(position.decisionId, resolution.hitType, exec);
    await appendAuditLog({
      eventType: 'position_closed_sim', actor: 'monitor',
      payload: { positionId: position.id, symbol: position.symbol, hitType: resolution.hitType,
        exitPrice: resolution.exitPrice, realizedPnl: resolution.realizedPnl },
    }, exec);
    return true;
  });
}
```

- [ ] **Step 14: Correr close-position y ver pasar**

Run: `npx vitest run src/lib/monitor/close-position.test.ts`
Expected: PASS.

- [ ] **Step 15: Test de `runMonitorTick` (unit, deps inyectadas)**

Crear `src/lib/monitor/monitor-tick.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { runMonitorTick, type MonitorTickDeps } from './monitor-tick.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';

function pos(id: string, over: Partial<OpenPosition> = {}): OpenPosition {
  return { id, symbol: 'BTC/USDT', strategyId: 's1', decisionId: 'd1', entry: 100, size: 1, sl: 95, tp: 110, entryFee: 0.1, triggerTimeframe: '15m', mode: 'sim', openedAt: new Date('2026-03-12T00:00:00Z'), ...over };
}
function deps(over: Partial<MonitorTickDeps> = {}): MonitorTickDeps {
  return {
    getOpenPositions: async () => [pos('p1')],
    getBar: async () => ({ open: 100, high: 101, low: 90, close: 96 }),   // toca SL (low 90 <= 95)
    closeOnBracket: vi.fn(async () => true),
    notify: vi.fn(async () => ({ messageId: 'm' })),
    onError: vi.fn(async () => {}),
    simParams: DEFAULT_SIM_PARAMS,
    mode: 'sim',
    ...over,
  };
}

describe('runMonitorTick', () => {
  test('vela que toca SL → cierra y notifica', async () => {
    const d = deps();
    const r = await runMonitorTick(new Date('2026-03-12T00:00:00Z'), d);
    expect(r).toEqual({ checked: 1, closed: 1 });
    expect(d.closeOnBracket).toHaveBeenCalledOnce();
    expect(d.notify).toHaveBeenCalledOnce();
  });

  test('vela que no toca SL/TP → no cierra ni notifica', async () => {
    const d = deps({ getBar: async () => ({ open: 100, high: 101, low: 99, close: 100 }) });
    const r = await runMonitorTick(new Date(), d);
    expect(r).toEqual({ checked: 1, closed: 0 });
    expect(d.notify).not.toHaveBeenCalled();
  });

  test('sin vela disponible → skip silencioso', async () => {
    const d = deps({ getBar: async () => null });
    const r = await runMonitorTick(new Date(), d);
    expect(r.closed).toBe(0);
  });

  test('closeOnBracket false (ya cerrada) → no notifica', async () => {
    const d = deps({ closeOnBracket: vi.fn(async () => false) });
    const r = await runMonitorTick(new Date(), d);
    expect(r.closed).toBe(0);
    expect(d.notify).not.toHaveBeenCalled();
  });

  test('error en una posición se aísla y se reporta; el tick sigue', async () => {
    const d = deps({
      getOpenPositions: async () => [pos('p1'), pos('p2')],
      getBar: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))                                  // p1 falla
        .mockResolvedValueOnce({ open: 100, high: 101, low: 90, close: 96 }),      // p2 toca SL
      onError: vi.fn(async () => {}),
    });
    const r = await runMonitorTick(new Date(), d);
    expect(d.onError).toHaveBeenCalledOnce();
    expect(r.checked).toBe(2);
    expect(r.closed).toBe(1);
  });
});
```

- [ ] **Step 16: Correr y ver fallar**

Run: `npx vitest run src/lib/monitor/monitor-tick.test.ts`
Expected: FAIL — `monitor-tick.ts` no existe.

- [ ] **Step 17: Implementar `runMonitorTick`**

Crear `src/lib/monitor/monitor-tick.ts`:

```ts
import { getMode, type TradingMode } from '../mode.ts';
import { getOpenPositions, type OpenPosition } from '../../db/repositories/positions.ts';
import { getLatestCandle } from '../../db/repositories/ohlcv-candles.ts';
import { resolveBracket } from '../execution/bracket.ts';
import { closePositionOnBracket } from './close-position.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { sendWhatsApp } from '../../notify/whatsapp.ts';
import { notifyBestEffort } from '../../notify/best-effort.ts';
import type { SimParams, BarOHLC, BracketResolution } from '../execution/types.ts';

export interface MonitorTickDeps {
  getOpenPositions: (mode: TradingMode) => Promise<OpenPosition[]>;
  getBar: (symbol: string, timeframe: string, asOf: Date, openedAt: Date) => Promise<BarOHLC | null>;
  closeOnBracket: (position: OpenPosition, resolution: BracketResolution, closedAt: Date) => Promise<boolean>;
  notify: (text: string) => Promise<{ messageId: string | null }>;
  onError: (positionId: string, err: unknown) => Promise<void>;
  simParams: SimParams;
  mode: TradingMode;
}

export interface MonitorTickResult { checked: number; closed: number; }

const DEFAULT_DEPS: MonitorTickDeps = {
  getOpenPositions,
  getBar: async (symbol, timeframe, asOf, openedAt) => {
    // minOpenTime = openedAt: solo velas que abrieron DESPUÉS de la entrada (no resolver la vela
    // de entrada — convención anti-look-ahead del backtester, §20).
    const c = await getLatestCandle(symbol, timeframe, asOf, openedAt);
    return c ? { open: c.o, high: c.h, low: c.l, close: c.c } : null;
  },
  closeOnBracket: closePositionOnBracket,
  notify: sendWhatsApp,
  onError: async (positionId, err) => {
    await appendAuditLog({ eventType: 'monitor_error', actor: 'monitor',
      payload: { positionId, error: err instanceof Error ? err.message : String(err) } });
  },
  simParams: DEFAULT_SIM_PARAMS,
  mode: getMode(),
};

// Resuelve una posición: lee su última vela, resuelve el bracket y cierra+notifica si toca.
async function checkPosition(position: OpenPosition, asOf: Date, deps: MonitorTickDeps): Promise<boolean> {
  const bar = await deps.getBar(position.symbol, position.triggerTimeframe, asOf, position.openedAt);
  if (!bar) return false;
  const resolution = resolveBracket(position, bar, deps.simParams);
  if (!resolution) return false;
  if (!(await deps.closeOnBracket(position, resolution, asOf))) return false;
  const icon = resolution.hitType === 'tp' ? '🟢' : '🔴';
  await notifyBestEffort(deps.notify,
    `${icon} ${position.symbol}: salida ${resolution.hitType.toUpperCase()} @ ${resolution.exitPrice} (pnl ${resolution.realizedPnl})`,
    'monitor');
  return true;
}

// Un tick del monitor: cada posición abierta se resuelve aislada; un fallo se reporta y el tick sigue.
export async function runMonitorTick(asOf: Date, deps: Partial<MonitorTickDeps> = {}): Promise<MonitorTickResult> {
  const resolved = { ...DEFAULT_DEPS, ...deps };
  const positions = await resolved.getOpenPositions(resolved.mode);
  let checked = 0, closed = 0;
  for (const position of positions) {
    checked++;
    try {
      if (await checkPosition(position, asOf, resolved)) closed++;
    } catch (err: unknown) {
      try { await resolved.onError(position.id, err); } catch { /* último recurso: handler también falló */ }
    }
  }
  return { checked, closed };
}
```

- [ ] **Step 18: Correr monitor-tick + suite + typecheck**

Run: `npx vitest run src/lib/monitor/monitor-tick.test.ts && npm run typecheck && npm test`
Expected: PASS en todo.

- [ ] **Step 19: Commit**

```bash
git add src/db/repositories/ohlcv-candles.ts src/db/repositories/ohlcv-candles.test.ts src/db/repositories/orders.ts src/db/repositories/orders.test.ts src/lib/monitor/ src/lib/monitor/*.test.ts
git commit -m "feat: monitor de salida — resolveBracket en vivo + cierre OCO transaccional (SP6 Task 4)"
```

---

## Task 5: Wiring del monitor en `worker.ts`

Cablear `monitor-tick` como segundo job repetible BullMQ, con cadencia propia. Glue fino; la lógica ya está testeada (Task 4). Se valida con typecheck + smoke manual (el entrypoint no se unit-testea, igual que el wiring del scan en SP5).

**Files:**
- Modify: `src/worker.ts`

**Interfaces:**
- Consumes: `runMonitorTick` (Task 4), `getBullConnection`, `Queue`, `Worker`.
- Produces: worker `monitor-tick` corriendo cada `MONITOR_INTERVAL_MS`.

- [ ] **Step 1: Añadir la cadencia del monitor**

En `src/worker.ts`, tras la definición de `SCAN_INTERVAL_MS` (línea 10), añadir:

```ts
const parsedMonitor = Number(process.env.MONITOR_INTERVAL_MS);
const MONITOR_INTERVAL_MS = Number.isFinite(parsedMonitor) && parsedMonitor > 0 ? parsedMonitor : 60 * 1000;
const MONITOR_QUEUE = 'monitor-tick';
```

Añadir el import:

```ts
import { runMonitorTick } from './lib/monitor/monitor-tick.ts';
```

- [ ] **Step 2: Cablear el worker y el scheduler del monitor**

En `main()`, tras el bloque del scan scheduler (línea 36) y antes del `process.stdout.write` final, añadir:

```ts
  const monitorWorker = new Worker(MONITOR_QUEUE, async () => { await runMonitorTick(new Date()); }, { connection: conn, concurrency: 1 });
  monitorWorker.on('error', (err) => process.stderr.write(`[monitor-worker] error: ${err}\n`));
  monitorWorker.on('failed', (job, err) => process.stderr.write(`[monitor-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));

  const monitorQueue = new Queue(MONITOR_QUEUE, { connection: conn });
  await monitorQueue.upsertJobScheduler(
    'monitor-tick',
    { every: MONITOR_INTERVAL_MS },
    { name: 'tick', data: {}, opts: { removeOnComplete: true } },
  );
```

Actualizar el log final:

```ts
  process.stdout.write(`[worker] arriba: evaluate-candidate + scan cada ${SCAN_INTERVAL_MS}ms + monitor cada ${MONITOR_INTERVAL_MS}ms\n`);
```

- [ ] **Step 3: Typecheck + smoke manual**

Run: `npm run typecheck`
Expected: sin errores.

Smoke manual (requiere `docker compose up -d`, `npm run migrate`, `npm run seed`, Redis y `.env`): `MONITOR_INTERVAL_MS=10000 npm run worker`. Verificar en el log la línea `monitor cada 10000ms` y que arranca sin crashear. Cortar con Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add src/worker.ts
git commit -m "feat: cablea monitor-tick en el worker (SP6 Task 5)"
```

---

## Task 6: Graceful shutdown

Apagado idempotente: lógica testeable en `lib/queue/shutdown.ts` (sin `process.exit` directo: se inyecta), cableada con deps reales en `worker.ts`.

**Files:**
- Create: `src/lib/queue/shutdown.ts`
- Test: `src/lib/queue/shutdown.test.ts`
- Modify: `src/worker.ts`

**Interfaces:**
- Produces: `createShutdown(deps: ShutdownDeps): () => Promise<void>` con `interface Closeable { close: () => Promise<void> }` y `ShutdownDeps { closeables; closeConnection; closePool; exit; log; timeoutMs; setTimer }`.

- [ ] **Step 1: Test de `createShutdown`**

Crear `src/lib/queue/shutdown.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { createShutdown, type ShutdownDeps } from './shutdown.ts';

function deps(over: Partial<ShutdownDeps> = {}): { d: ShutdownDeps; calls: string[]; exits: number[] } {
  const calls: string[] = [];
  const exits: number[] = [];
  const d: ShutdownDeps = {
    closeables: [{ close: async () => { calls.push('w1'); } }, { close: async () => { calls.push('w2'); } }],
    closeConnection: async () => { calls.push('conn'); },
    closePool: async () => { calls.push('pool'); },
    exit: (c) => { exits.push(c); },
    log: () => {},
    timeoutMs: 1000,
    setTimer: () => ({ clear: () => {} }),
    ...over,
  };
  return { d, calls, exits };
}

describe('createShutdown', () => {
  test('cierra closeables, conexión y pool en orden, y sale 0', async () => {
    const { d, calls, exits } = deps();
    await createShutdown(d)();
    expect(calls).toEqual(['w1', 'w2', 'conn', 'pool']);
    expect(exits).toEqual([0]);
  });

  test('idempotente: una segunda llamada no recierra', async () => {
    let n = 0;
    const { d, exits } = deps({ closeables: [{ close: async () => { n++; } }] });
    const shutdown = createShutdown(d);
    await shutdown();
    await shutdown();
    expect(n).toBe(1);
    expect(exits).toEqual([0]);
  });

  test('si un close falla → exit 1', async () => {
    const { d, exits } = deps({ closeables: [{ close: async () => { throw new Error('boom'); } }] });
    await createShutdown(d)();
    expect(exits).toEqual([1]);
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/queue/shutdown.test.ts`
Expected: FAIL — `shutdown.ts` no existe.

- [ ] **Step 3: Implementar `createShutdown`**

Crear `src/lib/queue/shutdown.ts`:

```ts
export interface Closeable { close: () => Promise<void>; }

export interface ShutdownDeps {
  closeables: Closeable[];
  closeConnection: () => Promise<void>;
  closePool: () => Promise<void>;
  exit: (code: number) => void;
  log: (msg: string) => void;
  timeoutMs: number;
  setTimer: (fn: () => void, ms: number) => { clear: () => void };
}

// Apagado idempotente: cierra workers/queues (terminan el job en vuelo y dejan de tomar nuevos),
// la conexión Redis y el pool PG. Un timer de gracia fuerza exit(1) si algún close cuelga.
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    deps.log('apagando: cerrando workers y conexiones...');
    const timer = deps.setTimer(() => { deps.log('timeout de apagado, forzando exit'); deps.exit(1); }, deps.timeoutMs);
    try {
      for (const c of deps.closeables) await c.close();
      await deps.closeConnection();
      await deps.closePool();
      timer.clear();
      deps.log('apagado limpio');
      deps.exit(0);
    } catch (err: unknown) {
      timer.clear();
      deps.log(`error en apagado: ${err instanceof Error ? err.message : String(err)}`);
      deps.exit(1);
    }
  };
}
```

- [ ] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/lib/queue/shutdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Exponer el cierre de la cola evaluate**

El singleton `Queue` de `evaluate-queue.ts` (lo crea `enqueueEvaluateCandidate` en el proceso worker) abre su propia conexión y no es accesible desde `worker.ts`. Exponer su cierre. En `src/lib/queue/evaluate-queue.ts`, añadir al final:

```ts
export async function closeEvaluateQueue(): Promise<void> {
  if (queue) { await queue.close(); queue = null; }
}
```

- [ ] **Step 6: Cablear el shutdown en `worker.ts`**

En `src/worker.ts`:

Imports y constante de timeout:

```ts
import { getBullConnection, closeBullConnection } from './lib/queue/connection.ts';
import { closeEvaluateQueue } from './lib/queue/evaluate-queue.ts';
import { pool } from './db/pool.ts';
import { createShutdown } from './lib/queue/shutdown.ts';
// …
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;
```

(Si ya hay un import de `getBullConnection`, añadir `closeBullConnection` a la misma línea.)

Capturar el worker de evaluate (cambiar `startEvaluateWorker();` por `const evaluateWorker = startEvaluateWorker();`).

Al final de `main()`, tras el log de arranque, registrar los handlers:

```ts
  const shutdown = createShutdown({
    // Incluye los Queue además de los Worker: cada Queue abre su propia conexión IORedis (duplicate);
    // cerrarlas evita conexiones colgadas. scanQueue/monitorQueue están en scope; la cola evaluate
    // es un singleton interno → se cierra vía closeEvaluateQueue.
    closeables: [scanWorker, evaluateWorker, monitorWorker, scanQueue, monitorQueue, { close: closeEvaluateQueue }],
    closeConnection: closeBullConnection,
    closePool: () => pool.end(),
    exit: (code) => process.exit(code),
    log: (msg) => process.stdout.write(`[worker] ${msg}\n`),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; },
  });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
```

- [ ] **Step 7: Typecheck + smoke manual**

Run: `npm run typecheck`
Expected: sin errores.

Smoke manual: `npm run worker`, esperar el log de arranque, Ctrl+C → ver `apagando…` y `apagado limpio`, y que el proceso termina (no queda colgado).

- [ ] **Step 8: Commit**

```bash
git add src/lib/queue/shutdown.ts src/lib/queue/shutdown.test.ts src/lib/queue/evaluate-queue.ts src/worker.ts
git commit -m "feat: graceful shutdown del worker (SIGTERM/SIGINT) (SP6 Task 6)"
```

---

## Task 7: Reconciler delgado de arranque

Pase de auto-consistencia de DB (sin ccxt): audita órdenes de entrada colgadas (pending sin fill) y legs OCO huérfanas (pending de posiciones ya cerradas). Lógica testeable inyectada; corre en `worker.ts` antes de programar el scan.

> **Omisión deliberada (no re-añadir):** NO se detecta "señal `fired` sin decisión" como huérfana. Las señales **skipped** (veredicto skip) y **deduped** tampoco persisten decisión, así que serían indistinguibles de una huérfana real a nivel DB → en un loop vivo el dedup descartaría una señal por tick en cada setup abierto y el check se inundaría de falsos positivos. Distinguirlas exige rastrear el ciclo de vida de la señal (`signals.status`), que es scope creep para un reconciler "delgado" y se difiere. El spec se actualizó para reflejar esto.

**Files:**
- Modify: `src/db/repositories/orders.ts` (queries)
- Create: `src/lib/reconcile/startup-reconcile.ts`
- Test: `src/lib/reconcile/startup-reconcile.test.ts`
- Modify: `src/worker.ts`

**Interfaces:**
- Consumes: `query`, `Executor`, `claimEntryOrder`, `insertBracketLeg` (en tests), `executeOrderSim`/`closeOpenPosition` (en tests).
- Produces:
  - `interface StuckOrderRow { id: string; idempotency_key: string; purpose: string }`.
  - `findStuckEntryOrders(mode, exec?): Promise<StuckOrderRow[]>`.
  - `findOrphanedClosedLegs(mode, exec?): Promise<StuckOrderRow[]>`.
  - `runStartupReconcile(deps?): Promise<{ stuckEntries: number; orphanedLegs: number }>` con `ReconcileDeps` inyectables.

- [ ] **Step 1: Tests de las queries (integración) y del orquestador (unit)**

Crear `src/lib/reconcile/startup-reconcile.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { persistDecision } from '../../db/repositories/decisions.ts';
import { claimEntryOrder, findStuckEntryOrders, findOrphanedClosedLegs } from '../../db/repositories/orders.ts';
import { executeOrderSim } from '../execution/execute-order.ts';
import { closeOpenPosition } from '../../db/repositories/positions.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { runStartupReconcile } from './startup-reconcile.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { RiskResult } from '../execution/types.ts';

const SYMBOL = 'RECONBTC/USDT';
const STRATEGY_ID = 'recon-test-strategy';
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: {}, version: 1, skillName: null };
const RISK_ALLOW: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 1, notional: 100, limitsSnapshot: {} };

async function seedDecision() {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`, [STRATEGY_ID, `{${SYMBOL}}`]);
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-13T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return { signalId, decision };
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('queries del reconciler', () => {
  test('findStuckEntryOrders detecta una entry pending sin fill', async () => {
    const { decision } = await seedDecision();
    const claimed = await claimEntryOrder({ idempotencyKey: `${decision.id}:stuck`, decisionId: decision.id, size: 1, mode: 'sim' });
    const stuck = await findStuckEntryOrders('sim');
    expect(stuck.some((o) => o.id === claimed!.id)).toBe(true);
  });

  test('findOrphanedClosedLegs detecta legs pending de una posición cerrada', async () => {
    const { signalId, decision } = await seedDecision();
    const exec = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    await closeOpenPosition(exec.positionId!, -1, new Date('2026-03-13T01:00:00Z')); // cierra SIN cerrar legs
    const orphans = await findOrphanedClosedLegs('sim');
    expect(orphans.filter((o) => o.purpose === 'sl' || o.purpose === 'tp').length).toBeGreaterThanOrEqual(2);
  });
});

describe('runStartupReconcile', () => {
  test('audita cada hallazgo y devuelve conteos', async () => {
    const audited: string[] = [];
    const r = await runStartupReconcile({
      findStuckEntries: async () => [{ id: 'o1', idempotency_key: 'k1', purpose: 'entry' }],
      findOrphanedLegs: async () => [{ id: 'o2', idempotency_key: 'k2', purpose: 'sl' }, { id: 'o3', idempotency_key: 'k3', purpose: 'tp' }],
      audit: async (e) => { audited.push(e.eventType); return 'id'; },
    });
    expect(r).toEqual({ stuckEntries: 1, orphanedLegs: 2 });
    expect(audited).toEqual(['reconcile_stuck_order', 'reconcile_orphaned_leg', 'reconcile_orphaned_leg']);
  });

  test('sin hallazgos no audita', async () => {
    let n = 0;
    const r = await runStartupReconcile({ findStuckEntries: async () => [], findOrphanedLegs: async () => [], audit: async () => { n++; return 'id'; } });
    expect(r).toEqual({ stuckEntries: 0, orphanedLegs: 0 });
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/reconcile/startup-reconcile.test.ts`
Expected: FAIL — las queries y `runStartupReconcile` no existen.

- [ ] **Step 3: Implementar las queries del reconciler**

En `src/db/repositories/orders.ts`, añadir al final:

```ts
export interface StuckOrderRow { id: string; idempotency_key: string; purpose: string; }

// Órdenes de entrada 'pending' sin fill, aisladas por modo. En sim la entry se llena en la misma
// transacción → en arranque limpio esto es ~vacío; el valor real es en testnet/live (claim y fill
// separados), donde habría que añadir además `AND o.created_at < now() - interval '5 minutes'`.
export async function findStuckEntryOrders(mode: TradingMode, exec: Executor = query): Promise<StuckOrderRow[]> {
  return exec<StuckOrderRow>(
    `SELECT o.id, o.idempotency_key, o.purpose
       FROM kairos.orders o
       LEFT JOIN kairos.fills f ON f.order_id = o.id
      WHERE o.purpose = 'entry' AND o.status = 'pending' AND f.id IS NULL AND o.mode = $1`,
    [mode],
  );
}

// Legs OCO 'pending' cuya posición ya está cerrada: huérfanas (deberían quedar filled/canceled al
// salir). Aisladas por modo. Nota: posiciones SP5 con decision_id NULL no se detectan (el JOIN no
// iguala NULL); son inocuas en sim y se aceptan en la transición.
export async function findOrphanedClosedLegs(mode: TradingMode, exec: Executor = query): Promise<StuckOrderRow[]> {
  return exec<StuckOrderRow>(
    `SELECT o.id, o.idempotency_key, o.purpose
       FROM kairos.orders o
       JOIN kairos.positions p ON p.decision_id = o.decision_id
      WHERE o.purpose IN ('sl', 'tp') AND o.status = 'pending' AND p.status = 'closed' AND p.mode = $1`,
    [mode],
  );
}
```

- [ ] **Step 4: Implementar `runStartupReconcile`**

Crear `src/lib/reconcile/startup-reconcile.ts`:

```ts
import { findStuckEntryOrders, findOrphanedClosedLegs, type StuckOrderRow } from '../../db/repositories/orders.ts';
import { appendAuditLog, type AuditLogEntry } from '../../db/repositories/audit-log.ts';
import { getMode } from '../mode.ts';

export interface ReconcileDeps {
  findStuckEntries: () => Promise<StuckOrderRow[]>;
  findOrphanedLegs: () => Promise<StuckOrderRow[]>;
  audit: (entry: AuditLogEntry) => Promise<string>;
}

export interface ReconcileResult { stuckEntries: number; orphanedLegs: number; }

const DEFAULT_DEPS: ReconcileDeps = {
  findStuckEntries: () => findStuckEntryOrders(getMode()),
  findOrphanedLegs: () => findOrphanedClosedLegs(getMode()),
  audit: appendAuditLog,
};

// Reconciler delgado de arranque: solo audita estados inconsistentes de DB (sin ccxt; el diff
// contra exchange es del sprint de testnet). Corre antes de que el scanner dispare.
export async function runStartupReconcile(deps: Partial<ReconcileDeps> = {}): Promise<ReconcileResult> {
  const resolved = { ...DEFAULT_DEPS, ...deps };
  const stuck = await resolved.findStuckEntries();
  for (const o of stuck) {
    await resolved.audit({ eventType: 'reconcile_stuck_order', actor: 'reconciler',
      payload: { orderId: o.id, idempotencyKey: o.idempotency_key, kind: 'stuck_entry' } });
  }
  const legs = await resolved.findOrphanedLegs();
  for (const o of legs) {
    await resolved.audit({ eventType: 'reconcile_orphaned_leg', actor: 'reconciler',
      payload: { orderId: o.id, idempotencyKey: o.idempotency_key, purpose: o.purpose } });
  }
  return { stuckEntries: stuck.length, orphanedLegs: legs.length };
}
```

- [ ] **Step 5: Correr y ver pasar**

Run: `npx vitest run src/lib/reconcile/startup-reconcile.test.ts && npm run typecheck`
Expected: PASS, sin errores de tipo.

- [ ] **Step 6: Cablear el reconciler de arranque en `worker.ts`**

En `src/worker.ts`, añadir el import:

```ts
import { runStartupReconcile } from './lib/reconcile/startup-reconcile.ts';
```

Al inicio de `main()`, antes de `startEvaluateWorker()`, correr el reconciler (debe terminar antes de que el scanner se programe — §5 del ARCHITECTURE):

```ts
  const recon = await runStartupReconcile();
  process.stdout.write(`[worker] reconcile de arranque: ${recon.stuckEntries} entradas colgadas, ${recon.orphanedLegs} legs huérfanas\n`);
```

- [ ] **Step 7: Typecheck + suite completa + smoke manual**

Run: `npm run typecheck && npm test`
Expected: PASS, sin regresiones.

Smoke manual: `npm run worker` → ver la línea `reconcile de arranque: …` antes del log de arranque del scan. Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add src/db/repositories/orders.ts src/lib/reconcile/ src/worker.ts
git commit -m "feat: reconciler delgado de arranque (auto-consistencia de DB) (SP6 Task 7)"
```

---

## Cierre

Tras la Task 7, con toda la suite en verde y typecheck limpio, usar **superpowers:finishing-a-development-branch** para mergear/cerrar. Actualizar `CLAUDE.md` (Estado del proyecto: SP6 hecho, Fase 1 cerrada en `sim`; el dedup per-setup ya no es bloqueador de testnet) como paso final, fuera del alcance de las tareas TDD.

**Verificación end-to-end sugerida antes de cerrar** (smoke vivo en sim, como en SP5): con datos backfilleados, `npm run worker` con intervalos cortos (`SCAN_INTERVAL_MS`, `MONITOR_INTERVAL_MS`) y observar una entrada que luego cierra por SL/TP, con su notificación y el audit `position_closed_sim`.
