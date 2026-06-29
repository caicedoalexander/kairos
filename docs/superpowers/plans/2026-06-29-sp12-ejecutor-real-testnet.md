# SP12 — Ejecutor real en testnet (entrada + OCO residente) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `KAIROS_MODE=testnet` coloque órdenes reales en Binance Spot testnet (entrada limit marketable IOC capada + OCO residente server-side) con idempotencia, auditoría y compensación, sin que ninguna posición quede desprotegida dentro de una ejecución sin crash.

**Architecture:** `executeOrderReal` es el hermano determinista de `executeOrderSim`: lock por setup → re-check dedup → claim DB → entrada real (ccxt unified `createOrder`) → fills reales → posición `protected=false` → OCO residente (endpoint crudo `privatePostOrderListOco`) por qty neta de fee → `protected=true`. Fallo de OCO o carrera de setup → cierre de emergencia (market IOC). El despacho por modo en `evaluateCandidate` enruta `testnet|live → executeOrderReal`; `sim` queda intacto. El LLM sigue en sombra.

**Tech Stack:** TypeScript (Node ESM, imports con extensión `.ts`), ccxt 4.5.60 (Binance spot, sandbox por `KAIROS_MODE != live`), ioredis (lock sobre `REDIS_URL`), Postgres (esquema `kairos`), Vitest, Valibot.

## Global Constraints

- **Spec fuente:** `docs/superpowers/specs/2026-06-29-sp12-ejecutor-real-testnet-design.md` (desbloqueado, v2.1). Toda divergencia se justifica, no se hace en silencio.
- **Línea roja:** ninguna tool de mutación entra al `tools:[]` de un agente; el camino del dinero es código determinista. SP12 no toca agentes ni el LLM (sigue en sombra).
- **Idempotencia en dos capas:** lock Redis por **setup** (`kairos:lock:setup:<strategyId>:<symbol>:<mode>`) + `UNIQUE(idempotency_key=signalId)` en `kairos.orders`. El `UNIQUE` es la red durable; el lock falla **cerrado** si Redis no responde.
- **Nunca se asume una orden ejecutada:** ante incertidumbre de la entrada → `pending_execution`, sin abrir posición. Marcadores durables para el reconciler de SP13: `positions.protected=false` y `orders.status='pending_execution'` con fill presente.
- **`positions.protected`:** columna nueva, default DB **false** (pesimista); `openPosition` recibe `protected` **explícito** (sim=`true`, real=`false`→`true` tras confirmar OCO).
- **OCO de venta spot:** TP = `LIMIT_MAKER` a `tp` (above); SL = `STOP_LOSS_LIMIT` con `stopPrice=sl` (below trigger) y `price=sl·(1−STOP_LIMIT_OFFSET_BPS/1e4)` (below límite, GTC). Qty = **neta de fee**, redondeada por `client.amountToPrecision`.
- **Cap de slippage de la entrada:** `refPrice·(1+slippage_bps/1e4)` con `slippage_bps=5` (`DEFAULT_SIM_PARAMS`). Desviación declarada del book-walk de §18.2.
- **Estilo:** funciones <50 líneas, archivos <800, inmutabilidad por defecto, validación en límites, sin secretos hardcodeados, sin `console.log`. Dependencias inyectables para test; ningún test toca testnet real (exchange siempre mockeado/inyectado).
- **Gate operativo:** SP12 sólo habilita **smoke vigilado**; el loop continuo desatendido se habilita en SP13.
- **Verificar ccxt contra su API real, no de memoria.** El endpoint `privatePostOrderListOco` y la forma de su respuesta se confirman en el smoke vivo (Task final).

---

### Task 1: Columna `positions.protected` + repo + callers

**Files:**
- Modify: `src/db/schema.sql` (añadir `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, patrón de SP6)
- Modify: `src/db/repositories/positions.ts` (`openPosition` con `protected` requerido; nuevo `setPositionProtected`)
- Modify: `src/lib/execution/execute-order.ts:51-55` (el `openPosition` de sim pasa `protected: true`)
- Modify: `src/lib/monitor/close-position.test.ts:25` y cualquier otro helper de test que llame `openPosition` (pasar `protected: true`)
- Test: `src/db/repositories/positions.protected.test.ts` (integración, Postgres del compose)

**Interfaces:**
- Produces:
  - `openPosition(p: OpenPositionInput, exec?): Promise<string>` donde `OpenPositionInput` gana `protected: boolean` (requerido).
  - `setPositionProtected(id: string, value: boolean, exec?): Promise<void>`
  - Columna `kairos.positions.protected boolean NOT NULL DEFAULT false`.

- [ ] **Step 1: Escribe el test de integración (falla)**

```ts
// src/db/repositories/positions.protected.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { openPosition, setPositionProtected } from './positions.ts';

const SYMBOL = 'PROTBTC/USDT';
const STRATEGY_ID = 'prot-test-strategy';

beforeAll(async () => {
  await migrate();
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
               VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`]);
});
afterEach(async () => { await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]); });
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('positions.protected', () => {
  test('openPosition persiste protected explícito; setPositionProtected lo cambia', async () => {
    const id = await openPosition({ symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110,
      strategyId: STRATEGY_ID, mode: 'testnet', protected: false });
    const before = await query<{ protected: boolean }>(`SELECT protected FROM kairos.positions WHERE id=$1`, [id]);
    expect(before[0].protected).toBe(false);

    await setPositionProtected(id, true);
    const after = await query<{ protected: boolean }>(`SELECT protected FROM kairos.positions WHERE id=$1`, [id]);
    expect(after[0].protected).toBe(true);
  });
});
```

- [ ] **Step 2: Corre el test — debe fallar**

Run: `npm test -- positions.protected`
Expected: FAIL (columna `protected` no existe / `setPositionProtected` no definida).

- [ ] **Step 3: Añade la migración idempotente**

`src/db/migrate.ts` **no** ejecuta SQL inline — lee `src/db/schema.sql` y lo aplica. El patrón del proyecto (ver SP6: `entry_fee`, `decision_id`) es añadir el `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` al final de la sección de posiciones en `schema.sql`. Añade ahí:

```sql
ALTER TABLE kairos.positions ADD COLUMN IF NOT EXISTS protected boolean NOT NULL DEFAULT false;
```

Localiza el bloque de `ALTER TABLE kairos.positions ADD COLUMN IF NOT EXISTS` existente y pon la nueva línea junto a ellos. `migrate.ts` no se toca.

- [ ] **Step 4: Modifica `openPosition` y añade `setPositionProtected`**

En `src/db/repositories/positions.ts`, cambia `OpenPositionInput` y `openPosition`:

```ts
export interface OpenPositionInput {
  symbol: string;
  entry: number;
  size: number;
  sl: number;
  tp: number;
  strategyId: string;
  mode: TradingMode;
  protected: boolean;    // SP12: requerido. sim=true (monitor paper); real=false→true tras OCO confirmado.
  entryFee?: number;
  decisionId?: string;
}

export async function openPosition(p: OpenPositionInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, entry_fee, decision_id, protected)
     VALUES ($1, $2, 'long', $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11)`,
    [id, p.symbol, p.entry, p.size, p.sl, p.tp, p.strategyId, p.mode, p.entryFee ?? 0, p.decisionId ?? null, p.protected],
  );
  return id;
}

// SP12: marca/desmarca la protección OCO confirmada de una posición.
export async function setPositionProtected(id: string, value: boolean, exec: Executor = query): Promise<void> {
  await exec(`UPDATE kairos.positions SET protected = $2 WHERE id = $1`, [id, value]);
}
```

- [ ] **Step 5: Actualiza los callers de `openPosition`**

En `src/lib/execution/execute-order.ts` (executeOrderSim, ~línea 51) añade `protected: true` al objeto:

```ts
      const positionId = await openPosition(
        { symbol: p.symbol, entry: fill.fillPrice, size: fill.qty, sl: p.decision.verdict.sl, tp: p.decision.verdict.tp,
          strategyId: p.strategy.id, mode: p.mode, entryFee: fill.fee, decisionId: p.decision.id, protected: true },
        exec,
      );
```

En `src/lib/monitor/close-position.test.ts` y cualquier otro test que llame `openPosition` directamente, añade `protected: true`. Localízalos:

```bash
grep -rln "openPosition(" src --include=*.ts
```

- [ ] **Step 6: Corre el test y la suite de positions — deben pasar**

Run: `npm test -- positions && npm run typecheck`
Expected: PASS; typecheck sin errores (todos los callers pasan `protected`).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/repositories/positions.ts src/db/repositories/positions.protected.test.ts src/lib/execution/execute-order.ts src/lib/monitor/close-position.test.ts
git commit -m "feat(sp12): columna positions.protected (marcador durable) + setPositionProtected"
```

---

### Task 2: `orders.ts` — `exchangeOrderId` en legs + `setOrderExchangeId`

**Files:**
- Modify: `src/db/repositories/orders.ts` (`BracketLegInput` + `insertBracketLeg` guardan `exchange_order_id`; nuevo `setOrderExchangeId`)
- Test: `src/db/repositories/orders.exchange-id.test.ts` (integración)

**Interfaces:**
- Consumes: columna `kairos.orders.exchange_order_id` (ya existe en el esquema, §264).
- Produces:
  - `BracketLegInput` gana `exchangeOrderId?: string`.
  - `setOrderExchangeId(id: string, exchangeOrderId: string, exec?): Promise<void>`

- [ ] **Step 1: Escribe el test (falla)**

```ts
// src/db/repositories/orders.exchange-id.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { persistDecision } from './decisions.ts';
import { insertSignal } from './signals.ts';
import { claimEntryOrder, insertBracketLeg, setOrderExchangeId } from './orders.ts';

const SYMBOL = 'EXIDBTC/USDT';
const STRATEGY_ID = 'exid-strategy';

beforeAll(async () => {
  await migrate();
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
               VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`]);
});
afterEach(async () => {
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('orders exchange_order_id', () => {
  test('setOrderExchangeId actualiza la entry; insertBracketLeg guarda el exchange id del leg', async () => {
    const signalId = await insertSignal({ strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-11T00:00:00Z'),
      snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } });
    const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
    const claim = await claimEntryOrder({ idempotencyKey: signalId, decisionId: decision.id, size: 1, mode: 'testnet' });
    await setOrderExchangeId(claim!.id, 'EX-ENTRY-1');
    await insertBracketLeg({ idempotencyKey: `${signalId}:sl`, decisionId: decision.id, size: 1, purpose: 'sl', parentId: claim!.id, mode: 'testnet', exchangeOrderId: 'EX-SL-1' });

    const rows = await query<{ purpose: string; exchange_order_id: string }>(
      `SELECT purpose, exchange_order_id FROM kairos.orders WHERE decision_id=$1 ORDER BY purpose`, [decision.id]);
    const entry = rows.find((r) => r.purpose === 'entry');
    const sl = rows.find((r) => r.purpose === 'sl');
    expect(entry?.exchange_order_id).toBe('EX-ENTRY-1');
    expect(sl?.exchange_order_id).toBe('EX-SL-1');
  });
});
```

- [ ] **Step 2: Corre el test — debe fallar**

Run: `npm test -- orders.exchange-id`
Expected: FAIL (`setOrderExchangeId` no existe; `insertBracketLeg` no acepta `exchangeOrderId`).

- [ ] **Step 3: Modifica `orders.ts`**

`BracketLegInput` y `insertBracketLeg`:

```ts
export interface BracketLegInput {
  idempotencyKey: string;
  decisionId: string;
  size: number;
  purpose: 'sl' | 'tp';
  parentId: string;
  mode: TradingMode;
  exchangeOrderId?: string;   // SP12: id del leg en el exchange (testnet/live); null en sim
}

export async function insertBracketLeg(leg: BracketLegInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, tif, purpose, parent_id, status, mode, exchange_order_id)
     VALUES ($1, $2, $3, 'sell', $4, $5, NULL, $6, $7, 'pending', $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [id, leg.idempotencyKey, leg.decisionId, leg.size, legType(leg.purpose), leg.purpose, leg.parentId, leg.mode, leg.exchangeOrderId ?? null],
  );
  return id;
}

// SP12: guarda el id de la orden en el exchange tras un fill real.
export async function setOrderExchangeId(id: string, exchangeOrderId: string, exec: Executor = query): Promise<void> {
  await exec(`UPDATE kairos.orders SET exchange_order_id = $2 WHERE id = $1`, [id, exchangeOrderId]);
}
```

- [ ] **Step 4: Corre el test — debe pasar**

Run: `npm test -- orders.exchange-id && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/orders.ts src/db/repositories/orders.exchange-id.test.ts
git commit -m "feat(sp12): orders guarda exchange_order_id en legs + setOrderExchangeId"
```

---

### Task 3: `withSetupLock` — lock Redis por setup (fail-closed)

**Files:**
- Create: `src/lib/execution/setup-lock.ts`
- Modify: `src/lib/execution/limits.ts` (constante `SETUP_LOCK_TTL_MS`)
- Test: `src/lib/execution/setup-lock.test.ts` (unit, ioredis mockeado)

**Interfaces:**
- Produces:
  - `SETUP_LOCK_TTL_MS = 45_000` (en `limits.ts`)
  - `interface LockClient { set(key, val, mode1, ttl, mode2): Promise<string|null>; eval(script, numkeys, ...args): Promise<unknown>; }`
  - `withSetupLock<T>(strategyId, symbol, mode, fn: () => Promise<T>, opts?: { client?: LockClient }): Promise<T | { lock: 'not_acquired' }>`
  - `NOT_ACQUIRED` sentinela exportado: `export const NOT_ACQUIRED = { lock: 'not_acquired' } as const;`

- [ ] **Step 1: Escribe el test (falla)**

```ts
// src/lib/execution/setup-lock.test.ts
import { describe, test, expect, vi } from 'vitest';
import { withSetupLock, NOT_ACQUIRED } from './setup-lock.ts';

function fakeClient(setReturns: (string | null)[]) {
  let i = 0;
  return {
    set: vi.fn(async () => setReturns[i++ % setReturns.length]),
    eval: vi.fn(async () => 1),
  };
}

describe('withSetupLock', () => {
  test('ejecuta fn y libera cuando adquiere (SET → OK)', async () => {
    const client = fakeClient(['OK']);
    const ran = await withSetupLock('s1', 'BTC/USDT', 'testnet', async () => 'done', { client });
    expect(ran).toBe('done');
    expect(client.set).toHaveBeenCalledOnce();
    expect(client.eval).toHaveBeenCalledOnce(); // release condicional por token
  });

  test('no ejecuta fn y devuelve NOT_ACQUIRED cuando el lock está tomado (SET → null)', async () => {
    const client = fakeClient([null]);
    const fn = vi.fn(async () => 'done');
    const r = await withSetupLock('s1', 'BTC/USDT', 'testnet', fn, { client });
    expect(r).toBe(NOT_ACQUIRED);
    expect(fn).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled(); // no soy dueño → no libero
  });

  test('fail-closed: si el cliente Redis lanza, NO ejecuta fn y propaga', async () => {
    const client = { set: vi.fn(async () => { throw new Error('redis down'); }), eval: vi.fn() };
    const fn = vi.fn(async () => 'done');
    await expect(withSetupLock('s1', 'BTC/USDT', 'testnet', fn, { client })).rejects.toThrow('redis down');
    expect(fn).not.toHaveBeenCalled();
  });

  test('libera aunque fn lance (finally)', async () => {
    const client = fakeClient(['OK']);
    await expect(withSetupLock('s1', 'BTC/USDT', 'testnet', async () => { throw new Error('boom'); }, { client }))
      .rejects.toThrow('boom');
    expect(client.eval).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Corre el test — debe fallar**

Run: `npm test -- setup-lock`
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Añade la constante en `limits.ts`**

```ts
// Lock por setup (SP12): TTL que acota el peor caso entrada + OCO(retries) + cierre de emergencia.
export const SETUP_LOCK_TTL_MS = 45_000;
```

- [ ] **Step 4: Implementa `setup-lock.ts`**

```ts
// src/lib/execution/setup-lock.ts
import IORedis from 'ioredis';
import { ulid } from 'ulidx';
import type { TradingMode } from '../mode.ts';
import { SETUP_LOCK_TTL_MS } from './limits.ts';

// Lock de mutua exclusión por SETUP (no por señal): el dedup de Kairos es per-setup. Fail-closed.
export const NOT_ACQUIRED = { lock: 'not_acquired' } as const;
export type NotAcquired = typeof NOT_ACQUIRED;

export interface LockClient {
  set(key: string, value: string, ttlMode: 'PX', ttl: number, nxMode: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

let shared: IORedis | null = null;
function defaultClient(): LockClient {
  if (shared) return shared as unknown as LockClient;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL no configurada (lock de setup)');
  shared = new IORedis(url);
  return shared as unknown as LockClient;
}

// Libera sólo si el valor sigue siendo mío (check-and-del atómico).
const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function withSetupLock<T>(
  strategyId: string, symbol: string, mode: TradingMode,
  fn: () => Promise<T>, opts: { client?: LockClient } = {},
): Promise<T | NotAcquired> {
  const client = opts.client ?? defaultClient();
  const key = `kairos:lock:setup:${strategyId}:${symbol}:${mode}`;
  const token = ulid();
  // Fail-closed: si SET lanza (Redis caído), propaga — NO ejecutamos sin lock.
  const acquired = await client.set(key, token, 'PX', SETUP_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') return NOT_ACQUIRED;
  try {
    return await fn();
  } finally {
    try { await client.eval(RELEASE_LUA, 1, key, token); } catch { /* best-effort; el TTL lo limpia */ }
  }
}
```

- [ ] **Step 5: Corre el test — debe pasar**

Run: `npm test -- setup-lock && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/execution/setup-lock.ts src/lib/execution/limits.ts src/lib/execution/setup-lock.test.ts
git commit -m "feat(sp12): withSetupLock (lock Redis por setup, fail-closed, release por token)"
```

---

### Task 4: Singleton ccxt autenticado

**Files:**
- Modify: `src/lib/ccxt-client.ts` (`getAuthenticatedClient` singleton)
- Test: `src/lib/ccxt-client.test.ts` (añade casos; ya existe)

**Interfaces:**
- Produces: `getAuthenticatedClient(): Exchange` — misma instancia por proceso (evita conflictos de nonce); `resetAuthenticatedClient()` para tests.

- [ ] **Step 1: Añade los tests (fallan)**

Añade a `src/lib/ccxt-client.test.ts`:

```ts
import { getAuthenticatedClient, resetAuthenticatedClient } from './ccxt-client.ts';

describe('getAuthenticatedClient (singleton)', () => {
  const OLD = { ...process.env };
  beforeEach(() => { resetAuthenticatedClient(); process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's'; process.env.KAIROS_MODE = 'testnet'; });
  afterEach(() => { process.env = { ...OLD }; resetAuthenticatedClient(); });

  test('devuelve la MISMA instancia en llamadas repetidas', () => {
    expect(getAuthenticatedClient()).toBe(getAuthenticatedClient());
  });

  test('sandbox activo cuando KAIROS_MODE != live', () => {
    const c = getAuthenticatedClient();
    expect(c.urls['api']).not.toBe(undefined); // sandbox cambió urls
  });
});
```

- [ ] **Step 2: Corre — debe fallar**

Run: `npm test -- ccxt-client`
Expected: FAIL (`getAuthenticatedClient`/`resetAuthenticatedClient` no existen).

- [ ] **Step 3: Implementa el singleton**

En `src/lib/ccxt-client.ts`, conserva `createAuthenticatedClient` como factory interno y añade:

```ts
let authClient: Exchange | null = null;

// Singleton autenticado: una sola instancia por proceso (el skill ccxt advierte que múltiples
// instancias con la misma key provocan conflictos de nonce). loadMarkets es perezoso (lo hace el caller).
export function getAuthenticatedClient(): Exchange {
  if (authClient) return authClient;
  authClient = createAuthenticatedClient();
  return authClient;
}

// Solo para tests: resetea el singleton.
export function resetAuthenticatedClient(): void { authClient = null; }
```

- [ ] **Step 4: Corre — debe pasar**

Run: `npm test -- ccxt-client && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ccxt-client.ts src/lib/ccxt-client.test.ts
git commit -m "feat(sp12): getAuthenticatedClient singleton (evita conflictos de nonce)"
```

---

### Task 5: `precision.ts` — helpers puros

**Files:**
- Create: `src/lib/execution/real-order/precision.ts`
- Test: `src/lib/execution/real-order/precision.test.ts` (unit, sin red)

**Interfaces:**
- Produces:
  - `capPrice(refPrice: number, slippageBps: number): number`
  - `stopLimitPrice(sl: number, offsetBps: number): number`
  - `interface CcxtFee { cost?: number; currency?: string }`
  - `feeInBase(fees: CcxtFee[] | undefined, single: CcxtFee | undefined, base: string): number`
  - `meetsLegMin(qty: number, price: number, minAmount: number, minCost: number): boolean`

> **Refinamiento declarado del spec:** el spec listaba `roundAmount`/`roundPrice`/`netSellableQty` en `precision.ts`. El redondeo a la precisión del exchange se delega a `client.amountToPrecision`/`priceToPrecision` (correcto para el modo TICK_SIZE de Binance y testeado por ccxt). `precision.ts` queda como **aritmética pura** (cap, offset del stop-límite, fee-en-base, mínimos); la resta neta `filledQty − feeBase` la hace el caller y la redondea con el cliente. Misma cobertura del requisito, mejor separación.

- [ ] **Step 1: Escribe el test (falla)**

```ts
// src/lib/execution/real-order/precision.test.ts
import { describe, test, expect } from 'vitest';
import { capPrice, stopLimitPrice, feeInBase, meetsLegMin } from './precision.ts';

describe('precision', () => {
  test('capPrice = ref·(1+bps/1e4)', () => {
    expect(capPrice(100, 5)).toBeCloseTo(100.05, 6);
  });
  test('stopLimitPrice = sl·(1−bps/1e4) (límite por debajo del trigger)', () => {
    expect(stopLimitPrice(100, 20)).toBeCloseTo(99.8, 6);
  });
  test('feeInBase suma sólo fees en la moneda base', () => {
    expect(feeInBase([{ cost: 0.001, currency: 'BTC' }, { cost: 0.5, currency: 'USDT' }], undefined, 'BTC')).toBeCloseTo(0.001, 9);
    expect(feeInBase(undefined, { cost: 0.002, currency: 'BTC' }, 'BTC')).toBeCloseTo(0.002, 9);
    expect(feeInBase(undefined, { cost: 0.3, currency: 'BNB' }, 'BTC')).toBe(0); // fee en BNB → 0 en base
  });
  test('meetsLegMin exige qty ≥ minAmount Y notional ≥ minCost', () => {
    expect(meetsLegMin(0.001, 100, 0.0001, 10)).toBe(true);
    expect(meetsLegMin(0.00005, 100, 0.0001, 10)).toBe(false); // qty < minAmount
    expect(meetsLegMin(0.05, 100, 0.0001, 10)).toBe(true);
    expect(meetsLegMin(0.05, 1, 0.0001, 10)).toBe(false);      // notional < minCost
  });
});
```

- [ ] **Step 2: Corre — debe fallar**

Run: `npm test -- real-order/precision`
Expected: FAIL.

- [ ] **Step 3: Implementa `precision.ts`**

```ts
// src/lib/execution/real-order/precision.ts
// Aritmética pura de precios/cantidades para el ejecutor real. Sin red, sin ccxt.

// Precio máximo aceptable de una entrada marketable (cap de slippage sobre refPrice).
export function capPrice(refPrice: number, slippageBps: number): number {
  return refPrice * (1 + slippageBps / 1e4);
}

// Precio límite de la leg STOP_LOSS_LIMIT: por debajo del trigger para que llene en una caída rápida.
export function stopLimitPrice(sl: number, offsetBps: number): number {
  return sl * (1 - offsetBps / 1e4);
}

export interface CcxtFee { cost?: number; currency?: string }

// Fee cobrado en la moneda base (0 si se pagó en quote o BNB). Lee order.fees[] o el único order.fee.
export function feeInBase(fees: CcxtFee[] | undefined, single: CcxtFee | undefined, base: string): number {
  const list = (fees && fees.length > 0) ? fees : (single ? [single] : []);
  return list.filter((f) => f.currency === base).reduce((sum, f) => sum + (f.cost ?? 0), 0);
}

// ¿La qty cumple los mínimos de la leg (cantidad y notional)?
export function meetsLegMin(qty: number, price: number, minAmount: number, minCost: number): boolean {
  return qty >= minAmount && qty * price >= minCost;
}
```

- [ ] **Step 4: Corre — debe pasar**

Run: `npm test -- real-order/precision && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/real-order/precision.ts src/lib/execution/real-order/precision.test.ts
git commit -m "feat(sp12): precision.ts (cap, stop-limit offset, fee-en-base, mínimos)"
```

---

### Task 6: `place-entry.ts` — entrada limit marketable IOC capada

**Files:**
- Create: `src/lib/execution/real-order/place-entry.ts`
- Test: `src/lib/execution/real-order/place-entry.test.ts` (unit, exchange fake)

**Interfaces:**
- Consumes: `capPrice` (Task 5); `DEFAULT_SIM_PARAMS.slippage_bps` (limits.ts).
- Produces:
  - `interface EntryClient { market(symbol): { id: string; base: string; limits: { amount: { min?: number }; cost: { min?: number } } }; amountToPrecision(symbol, amt): string; priceToPrecision(symbol, price): string; createOrder(symbol, type, side, amount, price, params): Promise<RawOrder>; }`
  - `interface PlaceEntryArgs { symbol: string; size: number; refPrice: number; slippageBps: number; }`
  - `type EntryResult = { belowMin: true } | { belowMin: false; filledQty: number; avgPrice: number; fee: number; feeBase: number; exchangeOrderId: string };`
  - `placeEntry(client: EntryClient, a: PlaceEntryArgs): Promise<EntryResult>`

- [ ] **Step 1: Escribe el test (falla)**

```ts
// src/lib/execution/real-order/place-entry.test.ts
import { describe, test, expect, vi } from 'vitest';
import { placeEntry } from './place-entry.ts';

const market = { id: 'BTCUSDT', base: 'BTC', limits: { amount: { min: 0.0001 }, cost: { min: 10 } } };
function client(order: unknown, capture?: (args: unknown[]) => void) {
  return {
    market: () => market,
    amountToPrecision: (_s: string, a: number) => String(a),
    priceToPrecision: (_s: string, p: number) => p.toFixed(2),
    createOrder: vi.fn(async (...args: unknown[]) => { capture?.(args); return order; }),
  };
}

describe('placeEntry', () => {
  test('coloca limit buy IOC capada y normaliza el fill (fee en base)', async () => {
    let captured: unknown[] = [];
    const c = client({ id: '777', filled: 0.01, average: 100.04, fee: { cost: 0.00001, currency: 'BTC' } }, (a) => { captured = a; });
    const r = await placeEntry(c, { symbol: 'BTC/USDT', size: 0.01, refPrice: 100, slippageBps: 5 });
    expect(r).toEqual({ belowMin: false, filledQty: 0.01, avgPrice: 100.04, fee: 0.00001, feeBase: 0.00001, exchangeOrderId: '777' });
    // cap = 100·1.0005 = 100.05 (priceToPrecision → "100.05"); IOC
    expect(captured[0]).toBe('BTC/USDT'); expect(captured[1]).toBe('limit'); expect(captured[2]).toBe('buy');
    expect(captured[4]).toBe('100.05'); expect((captured[5] as { timeInForce: string }).timeInForce).toBe('IOC');
  });

  test('size por debajo del mínimo de notional → { belowMin: true } sin tocar el exchange', async () => {
    const c = client({});
    const r = await placeEntry(c, { symbol: 'BTC/USDT', size: 0.00001, refPrice: 100, slippageBps: 5 }); // notional 0.001 < 10
    expect(r).toEqual({ belowMin: true });
    expect(c.createOrder).not.toHaveBeenCalled();
  });

  test('fill cero (IOC no cruzó) → filledQty 0', async () => {
    const c = client({ id: '0', filled: 0, average: undefined, fee: undefined });
    const r = await placeEntry(c, { symbol: 'BTC/USDT', size: 0.01, refPrice: 100, slippageBps: 5 });
    expect(r).toEqual({ belowMin: false, filledQty: 0, avgPrice: 0, fee: 0, feeBase: 0, exchangeOrderId: '0' });
  });
});
```

- [ ] **Step 2: Corre — debe fallar**

Run: `npm test -- real-order/place-entry`
Expected: FAIL.

- [ ] **Step 3: Implementa `place-entry.ts`**

```ts
// src/lib/execution/real-order/place-entry.ts
import { capPrice, feeInBase, meetsLegMin, type CcxtFee } from './precision.ts';

export interface EntryClient {
  market(symbol: string): { id: string; base: string; limits: { amount: { min?: number }; cost: { min?: number } } };
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  createOrder(symbol: string, type: string, side: string, amount: number, price: number, params: Record<string, unknown>): Promise<RawOrder>;
}
interface RawOrder { id: string; filled?: number; average?: number; fee?: CcxtFee; fees?: CcxtFee[] }

export interface PlaceEntryArgs { symbol: string; size: number; refPrice: number; slippageBps: number }
export type EntryResult =
  | { belowMin: true }
  | { belowMin: false; filledQty: number; avgPrice: number; fee: number; feeBase: number; exchangeOrderId: string };

// Entrada limit marketable IOC capada al peor precio aceptable. Devuelve el fill normalizado.
export async function placeEntry(client: EntryClient, a: PlaceEntryArgs): Promise<EntryResult> {
  const market = client.market(a.symbol);
  const cap = Number(client.priceToPrecision(a.symbol, capPrice(a.refPrice, a.slippageBps)));
  const amount = Number(client.amountToPrecision(a.symbol, a.size));
  // Mínimos del market sobre el refPrice (estimación pre-trade): no enviar polvo.
  if (!meetsLegMin(amount, a.refPrice, market.limits.amount.min ?? 0, market.limits.cost.min ?? 0)) {
    return { belowMin: true };
  }
  const order = await client.createOrder(a.symbol, 'limit', 'buy', amount, cap, { timeInForce: 'IOC' });
  const filledQty = order.filled ?? 0;
  const totalFee = sumFee(order);
  return {
    belowMin: false,
    filledQty,
    avgPrice: order.average ?? 0,
    fee: totalFee,
    feeBase: feeInBase(order.fees, order.fee, market.base),
    exchangeOrderId: String(order.id),
  };
}

function sumFee(order: RawOrder): number {
  if (order.fees && order.fees.length > 0) return order.fees.reduce((s, f) => s + (f.cost ?? 0), 0);
  return order.fee?.cost ?? 0;
}
```

- [ ] **Step 4: Corre — debe pasar**

Run: `npm test -- real-order/place-entry && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/real-order/place-entry.ts src/lib/execution/real-order/place-entry.test.ts
git commit -m "feat(sp12): place-entry (limit marketable IOC capada, fill normalizado)"
```

---

### Task 7: `place-oco.ts` — OCO residente vía endpoint crudo de Binance

**Files:**
- Create: `src/lib/execution/real-order/place-oco.ts`
- Modify: `src/lib/execution/limits.ts` (`STOP_LIMIT_OFFSET_BPS`, `MAX_OCO_RETRIES`)
- Test: `src/lib/execution/real-order/place-oco.test.ts` (unit, fake + ccxt.NetworkError)

**Interfaces:**
- Consumes: `stopLimitPrice` (Task 5); `STOP_LIMIT_OFFSET_BPS`, `MAX_OCO_RETRIES` (limits.ts).
- Produces:
  - `interface OcoClient { market(symbol): { id: string }; amountToPrecision(symbol, amt): string; priceToPrecision(symbol, price): string; privatePostOrderListOco(params): Promise<OcoRaw>; }`
  - `interface PlaceOcoArgs { symbol: string; qty: number; sl: number; tp: number }`
  - `interface OcoResult { orderListId: string; slOrderId: string; tpOrderId: string }`
  - `placeOco(client: OcoClient, a: PlaceOcoArgs): Promise<OcoResult>`

> **Verificación obligatoria (Riesgo #1 del spec):** los nombres de parámetro de `privatePostOrderListOco` (above/below) y la forma de `orderReports` siguen la doc de Binance `POST /api/v3/orderList/oco`. Se confirman en el smoke vivo (Task final). Si el endpoint difiere en testnet, ajustar aquí — la lógica de retry/parseo no cambia.

- [ ] **Step 1: Escribe el test (falla)**

```ts
// src/lib/execution/real-order/place-oco.test.ts
import { describe, test, expect, vi } from 'vitest';
import ccxt from 'ccxt';
import { placeOco } from './place-oco.ts';

const okRaw = {
  orderListId: 123,
  orderReports: [
    { orderId: 9001, type: 'LIMIT_MAKER' },
    { orderId: 9002, type: 'STOP_LOSS_LIMIT' },
  ],
};
function client(impl: () => Promise<unknown>, capture?: (p: Record<string, string>) => void) {
  return {
    market: () => ({ id: 'BTCUSDT' }),
    amountToPrecision: (_s: string, a: number) => String(a),
    priceToPrecision: (_s: string, p: number) => p.toFixed(2),
    privatePostOrderListOco: vi.fn(async (p: Record<string, string>) => { capture?.(p); return impl(); }),
  };
}

describe('placeOco', () => {
  test('construye SELL OCO (TP LIMIT_MAKER above, SL STOP_LOSS_LIMIT below) y parsea ids', async () => {
    let p: Record<string, string> = {};
    const c = client(async () => okRaw, (x) => { p = x; });
    const r = await placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 });
    expect(r).toEqual({ orderListId: '123', slOrderId: '9002', tpOrderId: '9001' });
    expect(p.symbol).toBe('BTCUSDT'); expect(p.side).toBe('SELL'); expect(p.quantity).toBe('0.01');
    expect(p.aboveType).toBe('LIMIT_MAKER'); expect(p.abovePrice).toBe('110.00');
    expect(p.belowType).toBe('STOP_LOSS_LIMIT'); expect(p.belowStopPrice).toBe('95.00');
    expect(p.belowPrice).toBe('94.81'); // 95·(1−0.002) = 94.81
    expect(p.belowTimeInForce).toBe('GTC');
  });

  test('reintenta ante NetworkError y luego cede al éxito', async () => {
    let n = 0;
    const c = client(async () => { if (n++ < 1) throw new ccxt.NetworkError('blip'); return okRaw; });
    const r = await placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 });
    expect(r.orderListId).toBe('123');
    expect(c.privatePostOrderListOco).toHaveBeenCalledTimes(2);
  });

  test('ExchangeError NO se reintenta (cede ya)', async () => {
    const c = client(async () => { throw new ccxt.ExchangeError('rechazo'); });
    await expect(placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 })).rejects.toThrow('rechazo');
    expect(c.privatePostOrderListOco).toHaveBeenCalledTimes(1);
  });

  test('agotados los retries de NetworkError → lanza', async () => {
    const c = client(async () => { throw new ccxt.NetworkError('down'); });
    await expect(placeOco(c, { symbol: 'BTC/USDT', qty: 0.01, sl: 95, tp: 110 })).rejects.toThrow('down');
  });
});
```

- [ ] **Step 2: Corre — debe fallar**

Run: `npm test -- real-order/place-oco`
Expected: FAIL.

- [ ] **Step 3: Añade constantes en `limits.ts`**

```ts
// OCO residente (SP12): offset del límite del stop bajo el trigger; reintentos + backoff del OCO ante blip de red.
export const STOP_LIMIT_OFFSET_BPS = 20;
export const MAX_OCO_RETRIES = 3;
export const OCO_RETRY_BACKOFF_MS = 300;   // base del backoff exponencial (300, 600, …)
```

- [ ] **Step 4: Implementa `place-oco.ts`**

```ts
// src/lib/execution/real-order/place-oco.ts
import ccxt from 'ccxt';
import { stopLimitPrice } from './precision.ts';
import { STOP_LIMIT_OFFSET_BPS, MAX_OCO_RETRIES, OCO_RETRY_BACKOFF_MS } from '../limits.ts';

export interface OcoClient {
  market(symbol: string): { id: string };
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  privatePostOrderListOco(params: Record<string, string>): Promise<OcoRaw>;
}
interface OcoRaw { orderListId: number; orderReports: Array<{ orderId: number; type: string }> }

export interface PlaceOcoArgs { symbol: string; qty: number; sl: number; tp: number }
export interface OcoResult { orderListId: string; slOrderId: string; tpOrderId: string }

// OCO de venta (protege un long): TP = LIMIT_MAKER above; SL = STOP_LOSS_LIMIT below (trigger + límite).
export async function placeOco(client: OcoClient, a: PlaceOcoArgs): Promise<OcoResult> {
  const params: Record<string, string> = {
    symbol: client.market(a.symbol).id,
    side: 'SELL',
    quantity: client.amountToPrecision(a.symbol, a.qty),
    aboveType: 'LIMIT_MAKER',
    abovePrice: client.priceToPrecision(a.symbol, a.tp),
    belowType: 'STOP_LOSS_LIMIT',
    belowStopPrice: client.priceToPrecision(a.symbol, a.sl),
    belowPrice: client.priceToPrecision(a.symbol, stopLimitPrice(a.sl, STOP_LIMIT_OFFSET_BPS)),
    belowTimeInForce: 'GTC',
  };
  const raw = await retryOnNetwork(() => client.privatePostOrderListOco(params), MAX_OCO_RETRIES);
  const sl = raw.orderReports.find((o) => o.type === 'STOP_LOSS_LIMIT');
  const tp = raw.orderReports.find((o) => o.type === 'LIMIT_MAKER');
  if (!sl || !tp) throw new Error('OCO sin legs SL/TP en orderReports');
  return { orderListId: String(raw.orderListId), slOrderId: String(sl.orderId), tpOrderId: String(tp.orderId) };
}

// Reintenta sólo errores de red (NetworkError ⊃ RequestTimeout/RateLimit/ExchangeNotAvailable),
// con backoff exponencial (M2: RateLimitExceeded sin espera empeora; el backoff lo alivia).
async function retryOnNetwork<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (!(err instanceof ccxt.NetworkError)) throw err;  // ExchangeError → no reintenta
      lastErr = err;
      if (i < attempts - 1) await sleep(OCO_RETRY_BACKOFF_MS * 2 ** i);
    }
  }
  throw lastErr;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
```

- [ ] **Step 5: Corre — debe pasar**

Run: `npm test -- real-order/place-oco && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/execution/real-order/place-oco.ts src/lib/execution/limits.ts src/lib/execution/real-order/place-oco.test.ts
git commit -m "feat(sp12): place-oco (OCO residente vía privatePostOrderListOco, retry de red)"
```

---

### Task 8: `emergency-close.ts` — cierre de emergencia (market IOC)

**Files:**
- Create: `src/lib/execution/real-order/emergency-close.ts`
- Test: `src/lib/execution/real-order/emergency-close.test.ts` (unit, fake)

**Interfaces:**
- Produces:
  - `interface EmergencyClient { market(symbol): { base: string }; createMarketSellOrder(symbol, amount): Promise<RawExit>; }`
  - `interface EmergencyArgs { symbol: string; qty: number }`
  - `interface ExitResult { exitPrice: number; exitFee: number; exchangeOrderId: string }`
  - `emergencyClose(client: EmergencyClient, a: EmergencyArgs): Promise<ExitResult>`

- [ ] **Step 1: Escribe el test (falla)**

```ts
// src/lib/execution/real-order/emergency-close.test.ts
import { describe, test, expect, vi } from 'vitest';
import { emergencyClose } from './emergency-close.ts';

describe('emergencyClose', () => {
  test('vende a mercado la qty y normaliza el fill de salida', async () => {
    const c = {
      market: () => ({ base: 'BTC' }),
      createMarketSellOrder: vi.fn(async () => ({ id: 'X9', average: 94.9, fee: { cost: 0.47, currency: 'USDT' } })),
    };
    const r = await emergencyClose(c, { symbol: 'BTC/USDT', qty: 0.01 });
    expect(r).toEqual({ exitPrice: 94.9, exitFee: 0.47, exchangeOrderId: 'X9' });
    expect(c.createMarketSellOrder).toHaveBeenCalledWith('BTC/USDT', 0.01);
  });
});
```

- [ ] **Step 2: Corre — debe fallar**

Run: `npm test -- real-order/emergency-close`
Expected: FAIL.

- [ ] **Step 3: Implementa `emergency-close.ts`**

```ts
// src/lib/execution/real-order/emergency-close.ts
import type { CcxtFee } from './precision.ts';

export interface EmergencyClient {
  market(symbol: string): { base: string };
  createMarketSellOrder(symbol: string, amount: number): Promise<RawExit>;
}
interface RawExit { id: string; average?: number; fee?: CcxtFee; fees?: CcxtFee[] }

export interface EmergencyArgs { symbol: string; qty: number }
export interface ExitResult { exitPrice: number; exitFee: number; exchangeOrderId: string }

// Aplana una posición real (market IOC). Único fail-safe cuando el OCO no se pudo colocar.
export async function emergencyClose(client: EmergencyClient, a: EmergencyArgs): Promise<ExitResult> {
  const order = await client.createMarketSellOrder(a.symbol, a.qty);
  const fee = (order.fees && order.fees.length > 0)
    ? order.fees.reduce((s, f) => s + (f.cost ?? 0), 0)
    : (order.fee?.cost ?? 0);
  return { exitPrice: order.average ?? 0, exitFee: fee, exchangeOrderId: String(order.id) };
}
```

- [ ] **Step 4: Corre — debe pasar**

Run: `npm test -- real-order/emergency-close && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/real-order/emergency-close.ts src/lib/execution/real-order/emergency-close.test.ts
git commit -m "feat(sp12): emergency-close (market IOC fail-safe)"
```

---

### Task 9: `execute-order-real.ts` — máquina de estados con compensación

**Files:**
- Modify: `src/lib/execution/types.ts:72-80` (`ExecutionResult.status` suma `'zero_fill' | 'emergency_closed'`)
- Modify: `src/lib/execution/execute-order.ts:13-17` (exportar `isOpenSetupViolation`)
- Create: `src/lib/execution/execute-order-real.ts`
- Test: `src/lib/execution/execute-order-real.integration.test.ts` (integración: Postgres real + exchange fake inyectado)

**Interfaces:**
- Consumes: `placeEntry`/`EntryResult` (T6), `placeOco`/`OcoResult` (T7), `emergencyClose`/`ExitResult` (T8), `withSetupLock`/`NOT_ACQUIRED` (T3), `meetsLegMin` (T5), repos `claimEntryOrder`/`getOrderByIdempotencyKey`/`updateOrderStatus`/`insertBracketLeg`/`setOrderExchangeId` (T2), `insertFill`, `openPosition`/`setPositionProtected`/`closeOpenPosition`/`hasOpenPositionForSetup` (T1), `appendAuditLog`, `isOpenSetupViolation`.
- Produces:
  - `interface ExecuteOrderRealParams { signalId; symbol; strategyId; decision: { id; verdict: Verdict }; riskResult: RiskResult; refPrice: number; mode: TradingMode }`
  - `interface RealOrderDeps { client; placeEntry; placeOco; emergencyClose; withLock?; hasOpenForSetup? }`
  - `executeOrderReal(p: ExecuteOrderRealParams, deps: RealOrderDeps): Promise<ExecutionResult>`

- [ ] **Step 1: Amplía `ExecutionResult` y exporta `isOpenSetupViolation`**

En `src/lib/execution/types.ts`:

```ts
export interface ExecutionResult {
  status: 'filled' | 'pending_execution' | 'duplicate' | 'deduped' | 'zero_fill' | 'emergency_closed';
  idempotencyKey: string;
  orderId: string;
  positionId: string | null;
  fillPrice: number | null;
  qty: number | null;
  fee: number | null;
}
```

En `src/lib/execution/execute-order.ts`, cambia `function isOpenSetupViolation` a `export function isOpenSetupViolation`.

- [ ] **Step 2: Escribe el test de integración (falla)**

```ts
// src/lib/execution/execute-order-real.integration.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { persistDecision } from '../../db/repositories/decisions.ts';
import { executeOrderReal, type RealOrderDeps } from './execute-order-real.ts';
import type { RiskResult, Verdict } from './types.ts';

const SYMBOL = 'REALBTC/USDT';
const STRATEGY_ID = 'real-strategy';
const VERDICT: Verdict = { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 };
const RISK: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 0.01, notional: 1, limitsSnapshot: {} };

// Lock que siempre adquiere (ejecuta fn directo); inyectable para no tocar Redis.
const passLock: NonNullable<RealOrderDeps['withLock']> = async (_s, _sym, _m, fn) => fn();

function baseDeps(over: Partial<RealOrderDeps>): RealOrderDeps {
  return {
    client: {
      market: () => ({ id: 'REALBTCUSDT', base: 'BTC', limits: { amount: { min: 0.0001 }, cost: { min: 0.1 } } }),
      amountToPrecision: (_s: string, a: number) => String(a),   // H2: el ejecutor llama amountToPrecision
      priceToPrecision: (_s: string, p: number) => String(p),
    } as never,
    placeEntry: async () => ({ belowMin: false, filledQty: 0.01, avgPrice: 100.04, fee: 0.00001, feeBase: 0.00001, exchangeOrderId: 'E1' }),
    placeOco: async () => ({ orderListId: 'L1', slOrderId: 'S1', tpOrderId: 'T1' }),
    emergencyClose: async () => ({ exitPrice: 94.9, exitFee: 0.4, exchangeOrderId: 'X1' }),
    withLock: passLock,
    hasOpenForSetup: async () => false,
    ...over,
  };
}

async function seed() {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
               VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO UPDATE SET trigger_config=$3::jsonb`,
    [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } })]);
  const signalId = await insertSignal({ strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-11T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } });
  const decision = await persistDecision(signalId, VERDICT);
  return { signalId, decision };
}
function params(signalId: string, decision: { id: string }) {
  return { signalId, symbol: SYMBOL, strategyId: STRATEGY_ID, decision: { id: decision.id, verdict: VERDICT }, riskResult: RISK, refPrice: 100, mode: 'testnet' as const };
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

describe('executeOrderReal', () => {
  test('camino feliz: filled, posición protected=true, legs con exchange id', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({}));
    expect(r.status).toBe('filled');
    const pos = await query<{ protected: boolean; size: string }>(`SELECT protected, size FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos[0].protected).toBe(true);
    expect(Number(pos[0].size)).toBeCloseTo(0.00999, 5); // 0.01 − feeBase 0.00001
    const legs = await query<{ purpose: string; exchange_order_id: string }>(`SELECT purpose, exchange_order_id FROM kairos.orders WHERE purpose IN ('sl','tp')`);
    expect(legs.map((l) => l.exchange_order_id).sort()).toEqual(['S1', 'T1']);
  });

  test('fallo de OCO → emergency_closed, posición cerrada', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({ placeOco: async () => { throw new Error('oco down'); } }));
    expect(r.status).toBe('emergency_closed');
    const pos = await query<{ status: string }>(`SELECT status FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos[0].status).toBe('closed');
  });

  test('fill incierto (placeEntry lanza) → pending_execution, sin posición', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({ placeEntry: async () => { throw new Error('timeout'); } }));
    expect(r.status).toBe('pending_execution');
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos.length).toBe(0);
    const ord = await query<{ status: string }>(`SELECT status FROM kairos.orders WHERE purpose='entry'`);
    expect(ord[0].status).toBe('pending_execution');
  });

  test('zero fill (IOC no cruzó) → zero_fill, sin posición', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({ placeEntry: async () => ({ belowMin: false, filledQty: 0, avgPrice: 0, fee: 0, feeBase: 0, exchangeOrderId: '0' }) }));
    expect(r.status).toBe('zero_fill');
    expect((await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL])).length).toBe(0);
  });

  test('lock no adquirido → deduped, no toca el exchange', async () => {
    const { signalId, decision } = await seed();
    let entryCalls = 0;
    const r = await executeOrderReal(params(signalId, decision), baseDeps({
      withLock: async () => ({ lock: 'not_acquired' }) as never,
      placeEntry: async () => { entryCalls++; return { belowMin: false, filledQty: 0.01, avgPrice: 100, fee: 0, feeBase: 0, exchangeOrderId: 'E' }; },
    }));
    expect(r.status).toBe('deduped');
    expect(entryCalls).toBe(0);
  });

  test('re-check dentro del lock: setup ya abierto → deduped sin comprar', async () => {
    const { signalId, decision } = await seed();
    let entryCalls = 0;
    const r = await executeOrderReal(params(signalId, decision), baseDeps({
      hasOpenForSetup: async () => true,
      placeEntry: async () => { entryCalls++; return { belowMin: false, filledQty: 0.01, avgPrice: 100, fee: 0, feeBase: 0, exchangeOrderId: 'E' }; },
    }));
    expect(r.status).toBe('deduped');
    expect(entryCalls).toBe(0);
  });

  test('idempotencia: segundo job con el mismo signalId → duplicate', async () => {
    const { signalId, decision } = await seed();
    await executeOrderReal(params(signalId, decision), baseDeps({}));
    const r2 = await executeOrderReal(params(signalId, decision), baseDeps({ hasOpenForSetup: async () => false }));
    expect(r2.status).toBe('duplicate');
  });

  // H4: carrera de setup (lock expirado). Hay una posición abierta del MISMO setup, pero el re-check
  // se saltea (hasOpenForSetup=false simula lock expirado/stale) → openPosition choca con el índice
  // único parcial idx_positions_open_setup (23505) → compensateSetupRace.
  test('carrera de setup (23505 en openPosition) → emergency_closed; entry queda filled', async () => {
    const { signalId, decision } = await seed();
    // Posición conflictiva preexistente del mismo (strategy, symbol, mode):
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, entry_fee, protected)
                 VALUES ('conflict01', $1, 'long', 100, 0.01, 95, 110, 'open', $2, 'testnet', 0, true)`, [SYMBOL, STRATEGY_ID]);
    let emergencyCalled = 0;
    const r = await executeOrderReal(params(signalId, decision), baseDeps({
      hasOpenForSetup: async () => false,   // simula lock expirado: el re-check no ve la posición
      emergencyClose: async () => { emergencyCalled++; return { exitPrice: 94.9, exitFee: 0.4, exchangeOrderId: 'X1' }; },
    }));
    expect(r.status).toBe('emergency_closed');
    expect(emergencyCalled).toBe(1);   // la compra real se aplanó
    const entry = await query<{ status: string }>(`SELECT status FROM kairos.orders WHERE idempotency_key=$1`, [signalId]);
    expect(entry[0].status).toBe('filled');
    await query(`DELETE FROM kairos.positions WHERE id='conflict01'`);
  });

  test('carrera de setup con emergencyClose que TAMBIÉN falla → re-lanza; entry pending_execution', async () => {
    const { signalId, decision } = await seed();
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, entry_fee, protected)
                 VALUES ('conflict02', $1, 'long', 100, 0.01, 95, 110, 'open', $2, 'testnet', 0, true)`, [SYMBOL, STRATEGY_ID]);
    await expect(executeOrderReal(params(signalId, decision), baseDeps({
      hasOpenForSetup: async () => false,
      emergencyClose: async () => { throw new Error('emergency down'); },
    }))).rejects.toThrow('emergency_close_failed');
    const entry = await query<{ status: string }>(`SELECT status FROM kairos.orders WHERE idempotency_key=$1`, [signalId]);
    expect(entry[0].status).toBe('pending_execution');   // marcador durable queryable (sin fila de posición)
    await query(`DELETE FROM kairos.positions WHERE id='conflict02'`);
  });
});
```

- [ ] **Step 3: Corre — debe fallar**

Run: `npm test -- execute-order-real`
Expected: FAIL (módulo no existe).

- [ ] **Step 4: Implementa `execute-order-real.ts`**

```ts
// src/lib/execution/execute-order-real.ts
import { claimEntryOrder, getOrderByIdempotencyKey, updateOrderStatus, insertBracketLeg, setOrderExchangeId } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { openPosition, setPositionProtected, closeOpenPosition, hasOpenPositionForSetup } from '../../db/repositories/positions.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { withSetupLock, NOT_ACQUIRED } from './setup-lock.ts';
import { isOpenSetupViolation } from './execute-order.ts';
import { meetsLegMin } from './real-order/precision.ts';
import { DEFAULT_SIM_PARAMS } from './limits.ts';
import type { EntryClient, PlaceEntryArgs, EntryResult } from './real-order/place-entry.ts';
import type { OcoClient, PlaceOcoArgs, OcoResult } from './real-order/place-oco.ts';
import type { EmergencyClient, EmergencyArgs, ExitResult } from './real-order/emergency-close.ts';
import type { Verdict, RiskResult, ExecutionResult } from './types.ts';
import type { TradingMode } from '../mode.ts';

export type RealClient = EntryClient & OcoClient & EmergencyClient;

export interface ExecuteOrderRealParams {
  signalId: string; symbol: string; strategyId: string;
  decision: { id: string; verdict: Verdict };
  riskResult: RiskResult; refPrice: number; mode: TradingMode;
}

export interface RealOrderDeps {
  client: RealClient;
  placeEntry: (client: EntryClient, a: PlaceEntryArgs) => Promise<EntryResult>;
  placeOco: (client: OcoClient, a: PlaceOcoArgs) => Promise<OcoResult>;
  emergencyClose: (client: EmergencyClient, a: EmergencyArgs) => Promise<ExitResult>;
  withLock?: typeof withSetupLock;
  hasOpenForSetup?: typeof hasOpenPositionForSetup;
}

function result(status: ExecutionResult['status'], idem: string, over: Partial<ExecutionResult> = {}): ExecutionResult {
  return { status, idempotencyKey: idem, orderId: over.orderId ?? '', positionId: over.positionId ?? null,
    fillPrice: over.fillPrice ?? null, qty: over.qty ?? null, fee: over.fee ?? null };
}

// Ejecutor real (testnet/live): máquina de estados con compensación. No usa transacción DB (las
// llamadas al exchange están fuera de cualquier tx); la seguridad es OCO residente o cierre de emergencia.
export async function executeOrderReal(p: ExecuteOrderRealParams, deps: RealOrderDeps): Promise<ExecutionResult> {
  const idem = p.signalId;
  const size = p.riskResult.adjustedSize;
  if (p.riskResult.result !== 'allow' || size === null) throw new Error('executeOrderReal requiere riskResult allow con adjustedSize');
  const withLock = deps.withLock ?? withSetupLock;
  const hasOpen = deps.hasOpenForSetup ?? hasOpenPositionForSetup;

  const locked = await withLock(p.strategyId, p.symbol, p.mode, async (): Promise<ExecutionResult> => {
    // Re-check dentro del lock (N5): el pre-check de evaluateCandidate corre fuera del lock.
    if (await hasOpen(p.strategyId, p.symbol, p.mode)) return result('deduped', idem);

    const claim = await claimEntryOrder({ idempotencyKey: idem, decisionId: p.decision.id, size, mode: p.mode });
    if (!claim) {
      const existing = await getOrderByIdempotencyKey(idem);
      return result('duplicate', idem, { orderId: existing?.id ?? '' });
    }

    // Entrada real (puede lanzar = incierta → nunca se asume llenada).
    let entry: EntryResult;
    try { entry = await deps.placeEntry(deps.client, { symbol: p.symbol, size, refPrice: p.refPrice, slippageBps: DEFAULT_SIM_PARAMS.slippage_bps }); }
    catch {
      await updateOrderStatus(claim.id, 'pending_execution');
      await appendAuditLog({ eventType: 'entry_uncertain', actor: 'execute-order-real', payload: { idem } });
      return result('pending_execution', idem, { orderId: claim.id });
    }
    if (entry.belowMin) {
      await updateOrderStatus(claim.id, 'canceled');
      await appendAuditLog({ eventType: 'entry_below_min', actor: 'execute-order-real', payload: { idem } });
      return result('zero_fill', idem, { orderId: claim.id });
    }
    if (entry.filledQty === 0) {
      await updateOrderStatus(claim.id, 'canceled');
      await appendAuditLog({ eventType: 'entry_zero_fill', actor: 'execute-order-real', payload: { idem } });
      return result('zero_fill', idem, { orderId: claim.id });
    }

    // Tengo BTC real. Qty vendible = neta de fee, redondeada a la precisión del exchange.
    const sellableQty = Number(deps.client.amountToPrecision(p.symbol, entry.filledQty - entry.feeBase));
    const market = deps.client.market(p.symbol);
    if (!meetsLegMin(sellableQty, p.refPrice, market.limits.amount.min ?? 0, market.limits.cost.min ?? 0)) {
      await deps.emergencyClose(deps.client, { symbol: p.symbol, qty: sellableQty });
      await updateOrderStatus(claim.id, 'pending_execution');
      await appendAuditLog({ eventType: 'entry_dust_unprotectable', actor: 'execute-order-real', payload: { idem, sellableQty } });
      return result('emergency_closed', idem, { orderId: claim.id });
    }

    await insertFill({ orderId: claim.id, price: entry.avgPrice, qty: entry.filledQty, fee: entry.fee });
    let positionId: string;
    try {
      positionId = await openPosition({ symbol: p.symbol, entry: entry.avgPrice, size: sellableQty, sl: p.decision.verdict.sl,
        tp: p.decision.verdict.tp, strategyId: p.strategyId, mode: p.mode, entryFee: entry.fee, decisionId: p.decision.id, protected: false });
      await updateOrderStatus(claim.id, 'filled');
      await setOrderExchangeId(claim.id, entry.exchangeOrderId);
    } catch (e) {
      if (!isOpenSetupViolation(e)) throw e;
      // Carrera de setup (edge: lock expirado). La compra real YA ocurrió → compensar.
      return await compensateSetupRace(deps, p, claim.id, sellableQty, idem);
    }

    // OCO residente. Fallo → cierre de emergencia (la posición ya existe).
    try {
      const oco = await deps.placeOco(deps.client, { symbol: p.symbol, qty: sellableQty, sl: p.decision.verdict.sl, tp: p.decision.verdict.tp });
      await insertBracketLeg({ idempotencyKey: `${idem}:sl`, decisionId: p.decision.id, size: sellableQty, purpose: 'sl', parentId: claim.id, mode: p.mode, exchangeOrderId: oco.slOrderId });
      await insertBracketLeg({ idempotencyKey: `${idem}:tp`, decisionId: p.decision.id, size: sellableQty, purpose: 'tp', parentId: claim.id, mode: p.mode, exchangeOrderId: oco.tpOrderId });
      await setPositionProtected(positionId, true);
      await appendAuditLog({ eventType: 'order_filled_real', actor: 'execute-order-real', payload: { idem, positionId, orderListId: oco.orderListId } });
      return result('filled', idem, { orderId: claim.id, positionId, fillPrice: entry.avgPrice, qty: sellableQty, fee: entry.fee });
    } catch {
      return await safeEmergency(deps, p, sellableQty, entry.avgPrice, positionId, claim.id, idem);
    }
  });

  return locked === NOT_ACQUIRED ? result('deduped', idem) : locked;
}

// Compensación cuando openPosition choca con el índice per-setup (la compra ya pasó, sin fila de posición).
async function compensateSetupRace(deps: RealOrderDeps, p: ExecuteOrderRealParams, orderId: string, qty: number, idem: string): Promise<ExecutionResult> {
  try {
    await deps.emergencyClose(deps.client, { symbol: p.symbol, qty });
    await updateOrderStatus(orderId, 'filled');
    await appendAuditLog({ eventType: 'oco_failed_emergency_closed', actor: 'execute-order-real', payload: { idem, reason: 'setup-race' } });
    return result('emergency_closed', idem, { orderId });
  } catch {
    // Marcador durable QUERYABLE: no hay fila de posición → la entry queda pending_execution.
    await updateOrderStatus(orderId, 'pending_execution');
    await appendAuditLog({ eventType: 'emergency_close_failed', actor: 'execute-order-real', payload: { idem, reason: 'setup-race' } });
    throw new Error(`emergency_close_failed (setup-race) idem=${idem} — posición real sin cerrar`);
  }
}

// Cierre de emergencia tras fallo de OCO (la fila de posición SÍ existe → protected=false es el marcador).
async function safeEmergency(deps: RealOrderDeps, p: ExecuteOrderRealParams, qty: number, avgFillPrice: number, positionId: string, orderId: string, idem: string): Promise<ExecutionResult> {
  try {
    const exit = await deps.emergencyClose(deps.client, { symbol: p.symbol, qty });
    const realized = (exit.exitPrice - avgFillPrice) * qty - exit.exitFee;   // L1: P&L con el fill real, no el planificado
    // M3: el fill de salida se registra contra la entry order (no hay leg en este camino). El reconciler
    //     de SP13 debe tratar 2 fills en una misma entry order como un cierre de emergencia al recalcular P&L.
    await insertFill({ orderId, price: exit.exitPrice, qty, fee: exit.exitFee });
    await closeOpenPosition(positionId, realized, new Date());
    await appendAuditLog({ eventType: 'oco_failed_emergency_closed', actor: 'execute-order-real', payload: { idem, positionId } });
    return result('emergency_closed', idem, { orderId, positionId });
  } catch {
    await appendAuditLog({ eventType: 'emergency_close_failed', actor: 'execute-order-real', payload: { idem, positionId } });
    throw new Error(`emergency_close_failed idem=${idem} positionId=${positionId} — posición real desprotegida (protected=false)`);
  }
}
```

> Nota: `closeOpenPosition` usa `new Date()`. En el archivo de workflow no aplica la restricción de `Date.now()` (ésa es de los scripts de Workflow), así que es válido aquí (igual que `closePositionOnBracket` en sim).

- [ ] **Step 5: Corre el test — debe pasar**

Run: `npm test -- execute-order-real && npm run typecheck`
Expected: PASS (9 casos, incluidos los dos de carrera de setup / 23505).

- [ ] **Step 6: Commit**

```bash
git add src/lib/execution/types.ts src/lib/execution/execute-order.ts src/lib/execution/execute-order-real.ts src/lib/execution/execute-order-real.integration.test.ts
git commit -m "feat(sp12): execute-order-real (máquina de estados con compensación + OCO residente)"
```

---

### Task 10: Despacho por modo en `evaluate-candidate.ts`

**Files:**
- Modify: `src/orchestration/evaluate-candidate.ts` (rama por modo + notify de nuevos estados + dep inyectable)
- Test: `src/orchestration/evaluate-candidate.test.ts` (añade casos de despacho)

**Interfaces:**
- Consumes: `executeOrderReal` (T9), `getMode`.
- Produces: `EvaluateDeps` gana `executeReal?: (signalId, args) => Promise<ExecutionResult>` (inyectable para test); en `testnet|live` se llama el ejecutor real con el singleton ccxt y los módulos reales.

- [ ] **Step 1: Añade el bloque de despacho por modo (falla)**

Añade al final de `src/orchestration/evaluate-candidate.test.ts` (reusa los helpers ya presentes en el archivo: `enterSignal`, `insertSignal`, `ALLOW_STATE`, `query`, `SYMBOL`). El `afterEach` existente ya limpia por `SYMBOL`. Restaura `KAIROS_MODE` para no contaminar otros tests:

```ts
describe('evaluateCandidate — despacho por modo (SP12)', () => {
  const OLD_MODE = process.env.KAIROS_MODE;
  afterEach(() => { process.env.KAIROS_MODE = OLD_MODE; });

  test('en testnet rutea a executeReal (NO al sim) y mapea el outcome', async () => {
    process.env.KAIROS_MODE = 'testnet';
    const signalId = await insertSignal(enterSignal());
    let realCalls = 0;
    const notify = vi.fn(async () => ({ messageId: 'm' }));
    const outcome = await evaluateCandidate(signalId, {
      notify, riskState: ALLOW_STATE,
      executeReal: async () => { realCalls++; return { status: 'filled', idempotencyKey: signalId, orderId: 'o', positionId: 'p', fillPrice: 100, qty: 0.01, fee: 0 }; },
    });
    expect(realCalls).toBe(1);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind === 'executed') expect(outcome.status).toBe('filled');
    // NO se creó posición vía sim (el executeReal fake no escribe DB)
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos.length).toBe(0);
  });

  test('en testnet con zero_fill → executed/zero_fill y notifica', async () => {
    process.env.KAIROS_MODE = 'testnet';
    const signalId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'm' }));
    const outcome = await evaluateCandidate(signalId, {
      notify, riskState: ALLOW_STATE,
      executeReal: async () => ({ status: 'zero_fill', idempotencyKey: signalId, orderId: '', positionId: null, fillPrice: null, qty: null, fee: null }),
    });
    expect(outcome).toEqual({ kind: 'executed', positionId: null, status: 'zero_fill' });
    expect(notify).toHaveBeenCalledOnce();
  });

  test('en sim NO se llama executeReal (rama intacta)', async () => {
    process.env.KAIROS_MODE = 'sim';
    const signalId = await insertSignal(enterSignal());
    let realCalls = 0;
    const outcome = await evaluateCandidate(signalId, {
      notify: vi.fn(async () => ({ messageId: 'm' })), riskState: ALLOW_STATE,
      executeReal: async () => { realCalls++; return { status: 'filled', idempotencyKey: signalId, orderId: '', positionId: null, fillPrice: null, qty: null, fee: null }; },
    });
    expect(realCalls).toBe(0);                  // sim usa executeOrderSim, no executeReal
    expect(outcome.kind).toBe('executed');
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos.length).toBe(1);                 // sim sí escribió la posición
  });
});
```

- [ ] **Step 2: Corre — debe fallar**

Run: `npm test -- evaluate-candidate`
Expected: FAIL (no existe `executeReal` en deps / despacho por modo).

- [ ] **Step 3: Implementa el despacho**

En `src/orchestration/evaluate-candidate.ts`:

1. Importa el ejecutor real y sus piezas:

```ts
import { executeOrderReal, type RealClient } from '../lib/execution/execute-order-real.ts';
import { getAuthenticatedClient } from '../lib/ccxt-client.ts';
import { placeEntry } from '../lib/execution/real-order/place-entry.ts';
import { placeOco } from '../lib/execution/real-order/place-oco.ts';
import { emergencyClose } from '../lib/execution/real-order/emergency-close.ts';
```

2. Añade `executeReal` a `EvaluateDeps` (inyectable; default real):

```ts
export interface EvaluateDeps {
  isPaused: () => Promise<boolean>;
  notify: (text: string, to?: string) => Promise<{ messageId: string | null }>;
  riskState?: GatheredState;
  executeReal?: (signalId: string, args: { symbol: string; strategyId: string; decision: { id: string; verdict: Verdict }; riskResult: RiskResult; refPrice: number; mode: TradingMode }) => Promise<ExecutionResult>;
}

const defaultExecuteReal: NonNullable<EvaluateDeps['executeReal']> = async (signalId, args) => {
  const client = getAuthenticatedClient();
  await client.loadMarkets();   // H3: idempotente en ccxt; necesario para client.market()/amountToPrecision
  return executeOrderReal({ signalId, ...args }, {
    client: client as unknown as RealClient,   // L2: cast explícito, no `as never`
    placeEntry, placeOco, emergencyClose,
  });
};
```

> **H3 (loadMarkets):** `getAuthenticatedClient()` se mantiene **sync** y sin red (así el test de Task 4 no toca el exchange). El `await client.loadMarkets()` se hace aquí, en `defaultExecuteReal` (sólo se ejecuta en el smoke vivo, nunca en CI porque los tests inyectan `executeReal`). `loadMarkets` cachea en ccxt, así que llamarlo por job es barato.

3. Sustituye la llamada única a `executeOrderSim` por el despacho. Reemplaza el bloque actual (líneas 69-72) por:

```ts
  const executeReal = deps.executeReal ?? defaultExecuteReal;
  const exec = mode === 'sim'
    ? await executeOrderSim({ signalId, symbol: signal.symbol, decision, riskResult: risk, strategy,
        referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode })
    : await executeReal(signalId, { symbol: signal.symbol, strategyId: signal.strategyId,
        decision, riskResult: risk, refPrice: verdict.entry, mode });
```

4. Amplía las ramas de notificación para los nuevos estados (tras el bloque `exec.status === 'filled'`):

```ts
  } else if (exec.status === 'zero_fill') {
    await notifyBestEffort(notify, `➖ ${signal.symbol}: sin posición (IOC no cruzó / size < mínimo)`, 'evaluate-candidate');
  } else if (exec.status === 'emergency_closed') {
    await notifyBestEffort(notify, `🚨 ${signal.symbol}: OCO no colocado — posición aplanada por emergencia`, 'evaluate-candidate');
  }
```

5. Añade los imports de tipos que falten (`Verdict`, `RiskResult`, `TradingMode`) desde sus módulos.

- [ ] **Step 4: Corre — debe pasar**

Run: `npm test -- evaluate-candidate && npm run typecheck`
Expected: PASS (sim sigue intacto; testnet rutea a `executeReal`).

- [ ] **Step 5: Corre la suite completa**

Run: `npm test && npm run typecheck`
Expected: PASS, cobertura ≥80%.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/evaluate-candidate.ts src/orchestration/evaluate-candidate.test.ts
git commit -m "feat(sp12): despacho por modo en evaluateCandidate (testnet/live → executeOrderReal)"
```

---

## Smoke vivo owner-gated (post-merge, VIGILADO — no es tarea de CI)

> No se corre en CI ni en SDD (requiere claves + gasto real en testnet). Lo ejecuta el owner tras el merge, **mirando**. Confirma la mayor incógnita del spec (Riesgo #1): la llamada OCO real.

1. `KAIROS_MODE=testnet` con `BINANCE_API_KEY/SECRET` de testnet, `REDIS_URL` y `DATABASE_URL` vivos.
2. Dispara **una** señal real (un símbolo major, size mínimo sobre el `minNotional` de Binance).
3. Verifica en Binance testnet (open orders) que el **OCO quedó residente** (un STOP_LOSS_LIMIT + un LIMIT_MAKER ligados por `orderListId`).
4. Verifica en DB: `positions.protected=true`, `orders` (entry + 2 legs) con `exchange_order_id`, `fills` con el fill real.
5. Si los nombres de parámetro de `privatePostOrderListOco` o la forma de `orderReports` difieren en testnet, ajusta `place-oco.ts` (la lógica de retry/parseo no cambia) y repite.
6. **No** habilitar el loop continuo desatendido — eso es SP13.

---

## Self-Review (autor)

**1. Cobertura del spec:**
- Despacho por modo → Task 10. ✓
- `withSetupLock` fail-closed + TTL + token → Task 3. ✓
- Re-check dentro del lock (N5) → Task 9 (estado `deduped` por `hasOpenForSetup`). ✓
- Singleton ccxt → Task 4. ✓
- `precision.ts` (cap, stop-limit, fee-en-base, mínimos) → Task 5. ✓
- place-entry / place-oco / emergency-close → Tasks 6/7/8. ✓
- OCO vía `privatePostOrderListOco` (incógnita resuelta) → Task 7 + smoke. ✓
- Máquina de estados + compensación (fallo OCO + carrera setup N1) → Task 9. ✓
- `positions.protected` default false, crash-safe → Task 1 + Task 9 (false→true tras OCO). ✓
- Estados `zero_fill`/`emergency_closed` → Task 9 (types) + Task 10 (notify). ✓
- Marcadores durables (`protected=false`, `pending_execution`) → Task 9. ✓
- qty neta de fee (H1) → Task 9 (`sellableQty`) + Task 5 (`feeInBase`). ✓
- `position.size = sellableQty` (N3) → Task 9. ✓
- check mínimo sobre `sellableQty` (N4) → Task 9 (`entry_dust_unprotectable`). ✓

**2. Placeholders:** ninguno — cada step trae código real y comando con salida esperada.

**3. Consistencia de tipos:** `EntryResult`/`OcoResult`/`ExitResult`/`ExecutionResult` se definen en Tasks 6/7/8/9 y se consumen con las mismas firmas en Task 9/10. `openPosition({... protected})` consistente entre Task 1 (def) y Task 9 (uso). `insertBracketLeg({... exchangeOrderId})` entre Task 2 y Task 9.

**Gap conocido (in-spec, diferido a SP13):** crash entre `openPosition` y confirmación de OCO, y fill incierto que sí llenó — cubiertos por marcadores durables, resueltos por el reconciler de SP13. Documentado en §Seguridad del spec.
