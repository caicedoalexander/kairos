# SP13 — Reconciler/monitor ccxt + frescura OHLCV (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Habilitar el loop testnet continuo y desatendido cerrando la precondición I1 (doble-compra) y haciendo que las posiciones cierren de verdad con P&L de fills reales, manteniendo el scanner alimentado.

**Architecture:** Tres subsistemas deterministas sobre el ejecutor real de SP12 (reconciler ccxt arranque+tick, monitor de cierres reales por polling REST, frescura OHLCV) + un gate de dedup setup-aware que cierra I1 por seguridad. Despacho por modo igual que SP12: `sim` conserva sus caminos intactos; `testnet|live` activan los reales. El LLM sigue en sombra.

**Tech Stack:** TypeScript (ESM, imports con extensión `.ts`), ccxt 4.5.60 (binance spot), BullMQ (jobs repetibles), Postgres (esquema `kairos`), Vitest, Valibot. Comentarios en español, identificadores en inglés.

**Spec:** `docs/superpowers/specs/2026-06-29-sp13-reconciler-monitor-ccxt-design.md` (v2, commit `a31dad0`).

## Global Constraints

- **Líneas rojas (CRITICAL, bloquean commit):** ninguna tool de mutación entra al `tools:[]` de un agente — el reconciler/monitor llaman ccxt **desde código de orquestación**, nunca desde un bucle de tool-calling LLM. El LLM sigue en sombra. Credenciales en closures (`getAuthenticatedClient`), nunca en input que elige el modelo. Ante incertidumbre de ejecución **nunca** se asume una orden llenada.
- **Idempotencia:** el ancla es la **fila de posición** (`idx_positions_open_setup` parcial único) + `orders.status`, **NO** los fills (FIX M2 — los fills son auditoría best-effort; sin columna nueva). `closeOpenPosition` solo cierra si `status='open'`.
- **FIX H1 (carrera reconciler-vs-executor):** el finder `findUnresolvedEntries` lleva filtro de frescura `created_at < now() - interval '5 minutes'` (≥ `SETUP_LOCK_TTL_MS=45_000`). El **gate** `isSetupOccupied`, en cambio, **NO** lleva filtro (una `pending_execution` fresca debe bloquear de inmediato).
- **FIX H2 (close-first):** el monitor real cierra la posición (`closeOpenPosition`) **antes** de insertar el fill de salida; solo registra el fill si el cierre devolvió `true`.
- **FIX H3 (verificado, ccxt 4.5.60):** `createOrder` mapea `params.clientOrderId → newClientOrderId`; `fetchOrder(undefined, symbol, { clientOrderId })` mapea a `origClientOrderId` y lanza `OrderNotFound` si no existe. Ambos verificados en `node_modules/ccxt/js/src/binance.js`.
- **FIX M1 (moneda del fee):** el P&L resta fees como escalares en quote; los fees por-trade pueden venir en BNB. Task 1 verifica en testnet y documenta/asegura el supuesto "fees en quote".
- **clientOrderId determinista** = `signalId` = `idempotency_key` (ULID 26 chars, cabe en el límite ~36 de Binance).
- Estilo: funciones <50 líneas, archivos <800, sin anidamiento >4 niveles, inmutabilidad por defecto, validación en límites, sin secretos hardcodeados, sin `console.log` de debug. Cobertura ≥80%.
- **Flue:** nada nuevo cae en `src/workflows|channels|agents/` (descubrimiento automático). Todo vive en `src/lib/...`, `src/db/...` y orquestación dirigida por código. Jobs repetibles vía `upsertJobScheduler` (patrón existente en `worker.ts`).

---

## File Structure

**Nuevos:**
- `src/lib/execution/real-order/client-order-id.ts` — helper puro `entryClientOrderId(signalId)`.
- `src/lib/execution/real-order/order-state.ts` — adaptador ccxt: `fetchEntryState`, `fetchLegState`, `fetchExitFromTrades` (parseo de estado de orden + trades en un solo lugar, testeable con mocks).
- `src/lib/execution/setup-occupied.ts` — `isSetupOccupied` (composición open-position OR unresolved-entry).
- `src/lib/reconcile/exchange-reconcile.ts` — reconciler ccxt (A.1 entradas inciertas + A.2 posiciones desprotegidas + orquestador `runExchangeReconcile`).
- `src/lib/monitor/monitor-real.ts` — `runMonitorTickReal` (close-first + handoff M3).
- `src/lib/market-data/refresh.ts` — `refreshOhlcv` (job de frescura).

**Modificados:**
- `src/lib/execution/real-order/place-entry.ts` — `clientOrderId` en `createOrder`.
- `src/db/repositories/fills.ts` — `getFillsForOrder`.
- `src/db/repositories/orders.ts` — `findUnresolvedEntries`, `hasUnresolvedEntryForSetup`, `getBracketLegs`.
- `src/db/repositories/positions.ts` — `findUnprotectedPositions`, `getProtectedOpenPositions`.
- `src/lib/execution/execute-order-real.ts` — usa `isSetupOccupied` (re-check) + pasa `clientOrderId`.
- `src/orchestration/evaluate-candidate.ts` — usa `isSetupOccupied` (pre-check).
- `src/lib/execution/limits.ts` — `RECONCILE_INTERVAL_MS`, `OHLCV_REFRESH_INTERVAL_MS`.
- `src/worker.ts` — reconcile arranque (por modo) + ticks reconcile/refresh + dispatch monitor por modo + shutdown.
- `CLAUDE.md`, `docs/PENDIENTES.md` — estado del proyecto.

---

## Task 1: clientOrderId determinista en placeEntry (FIX H3) + verificación de fees (FIX M1)

**Files:**
- Create: `src/lib/execution/real-order/client-order-id.ts`
- Create: `src/lib/execution/real-order/client-order-id.test.ts`
- Modify: `src/lib/execution/real-order/place-entry.ts` (interface `PlaceEntryArgs`, body de `placeEntry`)
- Modify: `src/lib/execution/real-order/place-entry.test.ts` (asserts del nuevo param)
- Modify: `src/lib/execution/execute-order-real.ts:59` (pasar `clientOrderId`)

**Interfaces:**
- Produces: `entryClientOrderId(signalId: string): string` (devuelve `signalId` verbatim; documenta el contrato clientOrderId=signalId=idempotency_key). `PlaceEntryArgs` gana `clientOrderId: string`. `placeEntry` pasa `{ timeInForce: 'IOC', clientOrderId: a.clientOrderId }` a `createOrder`.

**Contexto:** verificado en `node_modules/ccxt/js/src/binance.js` que `createOrderRequest` lee `safeStringN(params, ['newClientOrderId','clientOrderId','origClientOrderId'])` y setea `request['newClientOrderId']`. Por eso basta añadir `clientOrderId` a los params de `createOrder`.

- [ ] **Step 1: Escribe el test del helper (falla)**

`src/lib/execution/real-order/client-order-id.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { entryClientOrderId } from './client-order-id.ts';

describe('entryClientOrderId', () => {
  it('devuelve el signalId verbatim (clientOrderId determinista = idempotency_key)', () => {
    expect(entryClientOrderId('01J9ZX8K7Q2M3N4P5R6S7T8U9V')).toBe('01J9ZX8K7Q2M3N4P5R6S7T8U9V');
  });

  it('cabe en el límite de newClientOrderId de Binance (≤ 36 chars) para un ULID de 26', () => {
    expect(entryClientOrderId('01J9ZX8K7Q2M3N4P5R6S7T8U9V').length).toBeLessThanOrEqual(36);
  });
});
```

- [ ] **Step 2: Corre el test, verifica que falla**

Run: `npm test -- src/lib/execution/real-order/client-order-id.test.ts`
Expected: FAIL ("Cannot find module './client-order-id.ts'").

- [ ] **Step 3: Implementa el helper**

`src/lib/execution/real-order/client-order-id.ts`:
```typescript
// clientOrderId determinista de la entrada (FIX H3 de SP13): = signalId = idempotency_key.
// Permite al reconciler recuperar una entrada incierta vía fetchOrder por origClientOrderId,
// sin emparejamiento difuso. El signalId es un ULID (26 chars Crockford base32), dentro del
// límite de newClientOrderId de Binance (~36) y de su charset permitido.
export function entryClientOrderId(signalId: string): string {
  return signalId;
}
```

- [ ] **Step 4: Corre el test del helper, verifica que pasa**

Run: `npm test -- src/lib/execution/real-order/client-order-id.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Añade `clientOrderId` a `PlaceEntryArgs` y al `createOrder`**

En `src/lib/execution/real-order/place-entry.ts`, cambia la interface y la llamada:
```typescript
export interface PlaceEntryArgs { symbol: string; size: number; refPrice: number; slippageBps: number; clientOrderId: string }
```
y en `placeEntry`, la línea del `createOrder`:
```typescript
  const order = await client.createOrder(a.symbol, 'limit', 'buy', amount, cap, { timeInForce: 'IOC', clientOrderId: a.clientOrderId });
```

- [ ] **Step 6: Actualiza el test de placeEntry para afirmar el clientOrderId**

En `src/lib/execution/real-order/place-entry.test.ts`, en cada llamada de prueba a `placeEntry`, añade `clientOrderId: 'sig-1'` al args, y en el test que verifica los params del `createOrder`, añade el assert (busca el `expect(...).toHaveBeenCalledWith(...)` del createOrder y extiende el objeto de params):
```typescript
    // El último argumento de createOrder son los params: debe incluir IOC + clientOrderId determinista.
    const params = createOrder.mock.calls[0][5];
    expect(params).toMatchObject({ timeInForce: 'IOC', clientOrderId: 'sig-1' });
```

- [ ] **Step 7: Pasa el `clientOrderId` desde `executeOrderReal`**

En `src/lib/execution/execute-order-real.ts:59`, cambia la llamada a `placeEntry` para incluir el clientOrderId (el `idem` ya es `p.signalId`):
```typescript
    try { entry = await deps.placeEntry(deps.client, { symbol: p.symbol, size, refPrice: p.refPrice, slippageBps: DEFAULT_SIM_PARAMS.slippage_bps, clientOrderId: idem }); }
```

- [ ] **Step 8: Corre los tests de la zona, verifica verde**

Run: `npm test -- src/lib/execution/real-order/ src/lib/execution/execute-order-real.test.ts`
Expected: PASS (placeEntry + execute-order-real verdes con el nuevo param).

- [ ] **Step 9: Verificación M1 (moneda del fee) — documenta el hallazgo**

Añade al final de `src/lib/execution/real-order/place-entry.ts` un comentario de bloque con el hallazgo verificado (no código): `binance parseOrder` da el fee a nivel orden en `quoteAsset`, pero `order.fees[]` (por-trade) lleva su `commissionAsset` real, que puede ser BNB si la cuenta tiene el descuento activo. **Decisión SP13:** el supuesto operativo es "fees en quote (USDT)"; el smoke owner-gated debe verificar en testnet la moneda real y, si aparece BNB, desactivar el descuento BNB en la cuenta de testnet (o el P&L del gate de drawdown se corrompe). Esto queda registrado para el smoke, no se normaliza en código en SP13.

```typescript
// FIX M1 (SP13): el P&L resta `fee`/`exitFee` como escalares en quote. Verificado contra ccxt:
// `order.fees[].cost` (por-trade) lleva su `commissionAsset` real, que puede ser BNB. El supuesto
// operativo de SP13 es "fees en quote (USDT)"; el smoke owner-gated verifica la moneda real en testnet
// y desactiva el descuento BNB si aparece. No se normaliza en código en SP13 (deuda declarada).
```

- [ ] **Step 10: Commit**

```bash
git add src/lib/execution/real-order/client-order-id.ts src/lib/execution/real-order/client-order-id.test.ts src/lib/execution/real-order/place-entry.ts src/lib/execution/real-order/place-entry.test.ts src/lib/execution/execute-order-real.ts
git commit -m "feat: clientOrderId determinista en placeEntry (SP13 FIX H3) + nota fee M1"
```

---

## Task 2: Adaptador de estado de orden ccxt (`order-state.ts`)

**Files:**
- Create: `src/lib/execution/real-order/order-state.ts`
- Create: `src/lib/execution/real-order/order-state.test.ts`

**Interfaces:**
- Produces:
  - `OrderStateClient` (subset de ccxt: `fetchOrder(id: string | undefined, symbol: string, params?: Record<string, unknown>): Promise<RawOrderState>`, `fetchOrderTrades(id: string, symbol: string): Promise<RawTrade[]>`).
  - `type EntryState = { found: false } | { found: true; status: string; filled: number; average: number; exchangeOrderId: string }` (FIX M-2: incluye el id real del exchange para `setOrderExchangeId`).
  - `fetchEntryState(client: OrderStateClient, symbol: string, clientOrderId: string): Promise<EntryState>`.
  - `fetchLegState(client: OrderStateClient, symbol: string, legId: string): Promise<{ status: string; filled: number }>`.
  - `interface ExitFromTrades { exitPrice: number; exitFee: number; qty: number }`.
  - `fetchExitFromTrades(client: OrderStateClient, symbol: string, orderId: string): Promise<ExitFromTrades>`.

**Contexto:** centraliza el parseo de la forma ccxt (status/filled/average; trades→vwap+fee) para que reconciler y monitor compartan una sola superficie testeable. `fetchEntryState` traduce `OrderNotFound` a `{ found: false }` (la entrada no llegó al exchange).

- [ ] **Step 1: Escribe los tests (fallan)**

`src/lib/execution/real-order/order-state.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import ccxt from 'ccxt';
import { fetchEntryState, fetchLegState, fetchExitFromTrades, type OrderStateClient } from './order-state.ts';

function client(over: Partial<OrderStateClient>): OrderStateClient {
  return {
    fetchOrder: async () => ({}),
    fetchOrderTrades: async () => [],
    ...over,
  };
}

describe('fetchEntryState', () => {
  it('orden llenada → found con status/filled/average/exchangeOrderId', async () => {
    const c = client({ fetchOrder: async () => ({ id: '12345678', status: 'closed', filled: 0.5, average: 100 }) });
    expect(await fetchEntryState(c, 'BTC/USDT', 'sig-1')).toEqual({ found: true, status: 'closed', filled: 0.5, average: 100, exchangeOrderId: '12345678' });
  });

  it('OrderNotFound → found:false (la entrada nunca llegó al exchange)', async () => {
    const c = client({ fetchOrder: async () => { throw new ccxt.OrderNotFound('no'); } });
    expect(await fetchEntryState(c, 'BTC/USDT', 'sig-1')).toEqual({ found: false });
  });

  it('NetworkError se propaga (no se traga)', async () => {
    const c = client({ fetchOrder: async () => { throw new ccxt.NetworkError('down'); } });
    await expect(fetchEntryState(c, 'BTC/USDT', 'sig-1')).rejects.toThrow(ccxt.NetworkError);
  });
});

describe('fetchLegState', () => {
  it('devuelve status/filled normalizados', async () => {
    const c = client({ fetchOrder: async () => ({ status: 'open', filled: 0 }) });
    expect(await fetchLegState(c, 'BTC/USDT', 'leg-1')).toEqual({ status: 'open', filled: 0 });
  });
});

describe('fetchExitFromTrades', () => {
  it('agrega trades a vwap + suma fees + qty', async () => {
    const c = client({ fetchOrderTrades: async () => [
      { price: 100, amount: 0.4, fee: { cost: 0.04, currency: 'USDT' } },
      { price: 110, amount: 0.6, fee: { cost: 0.066, currency: 'USDT' } },
    ] });
    const r = await fetchExitFromTrades(c, 'BTC/USDT', 'leg-1');
    expect(r.qty).toBeCloseTo(1.0, 8);
    expect(r.exitPrice).toBeCloseTo(106, 8); // (100*0.4 + 110*0.6) / 1.0
    expect(r.exitFee).toBeCloseTo(0.106, 8);
  });

  it('sin trades → exitPrice 0, qty 0 (el caller decide qué hacer)', async () => {
    const c = client({ fetchOrderTrades: async () => [] });
    expect(await fetchExitFromTrades(c, 'BTC/USDT', 'leg-1')).toEqual({ exitPrice: 0, exitFee: 0, qty: 0 });
  });
});
```

- [ ] **Step 2: Corre, verifica que fallan**

Run: `npm test -- src/lib/execution/real-order/order-state.test.ts`
Expected: FAIL ("Cannot find module './order-state.ts'").

- [ ] **Step 3: Implementa el adaptador**

`src/lib/execution/real-order/order-state.ts`:
```typescript
import ccxt from 'ccxt';

interface RawOrderState { id?: string; status?: string; filled?: number; average?: number }
interface RawTrade { price?: number; amount?: number; fee?: { cost?: number; currency?: string }; fees?: Array<{ cost?: number; currency?: string }> }

export interface OrderStateClient {
  fetchOrder(id: string | undefined, symbol: string, params?: Record<string, unknown>): Promise<RawOrderState>;
  fetchOrderTrades(id: string, symbol: string): Promise<RawTrade[]>;
}

// FIX M-2: `exchangeOrderId` lleva el id real que asigna Binance (para persistir en orders.exchange_order_id),
// NO el clientOrderId con el que se consultó.
export type EntryState = { found: false } | { found: true; status: string; filled: number; average: number; exchangeOrderId: string };

// Recupera el estado de una entrada por clientOrderId (origClientOrderId en binance). OrderNotFound
// significa que la entrada nunca llegó al exchange → found:false. NetworkError se propaga (retry del caller).
export async function fetchEntryState(client: OrderStateClient, symbol: string, clientOrderId: string): Promise<EntryState> {
  try {
    const o = await client.fetchOrder(undefined, symbol, { clientOrderId });
    return { found: true, status: o.status ?? 'unknown', filled: o.filled ?? 0, average: o.average ?? 0, exchangeOrderId: String(o.id ?? '') };
  } catch (err) {
    if (err instanceof ccxt.OrderNotFound) return { found: false };
    throw err;
  }
}

export async function fetchLegState(client: OrderStateClient, symbol: string, legId: string): Promise<{ status: string; filled: number }> {
  const o = await client.fetchOrder(legId, symbol);
  return { status: o.status ?? 'unknown', filled: o.filled ?? 0 };
}

export interface ExitFromTrades { exitPrice: number; exitFee: number; qty: number }

// Reconstruye el exit real desde los trades de una orden de salida (leg OCO o market de emergencia):
// precio = vwap, fee = suma de comisiones, qty = suma de amounts.
export async function fetchExitFromTrades(client: OrderStateClient, symbol: string, orderId: string): Promise<ExitFromTrades> {
  const trades = await client.fetchOrderTrades(orderId, symbol);
  let qty = 0, gross = 0, fee = 0;
  for (const t of trades) {
    const a = t.amount ?? 0;
    qty += a;
    gross += (t.price ?? 0) * a;
    fee += sumTradeFee(t);
  }
  return { exitPrice: qty > 0 ? gross / qty : 0, exitFee: fee, qty };
}

function sumTradeFee(t: RawTrade): number {
  if (t.fees && t.fees.length > 0) return t.fees.reduce((s, f) => s + (f.cost ?? 0), 0);
  return t.fee?.cost ?? 0;
}
```

- [ ] **Step 4: Corre los tests, verifica verde**

Run: `npm test -- src/lib/execution/real-order/order-state.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/real-order/order-state.ts src/lib/execution/real-order/order-state.test.ts
git commit -m "feat: adaptador de estado de orden ccxt (fetchEntryState/fetchLegState/fetchExitFromTrades) — SP13"
```

---

## Task 3: Lecturas de repo para SP13 (fills, orders, positions)

**Files:**
- Modify: `src/db/repositories/fills.ts` (+ `getFillsForOrder`)
- Modify: `src/db/repositories/orders.ts` (+ `findUnresolvedEntries`, `hasUnresolvedEntryForSetup`, `getBracketLegs`)
- Modify: `src/db/repositories/positions.ts` (+ `findUnprotectedPositions`, `getProtectedOpenPositions`)
- Test: `src/db/repositories/sp13-reads.test.ts` (integración, toca Postgres del compose)

**Interfaces:**
- Produces:
  - `getFillsForOrder(orderId: string, exec?): Promise<{ price: number; qty: number; fee: number }[]>`.
  - `interface UnresolvedEntry { id: string; idempotencyKey: string; decisionId: string; symbol: string; strategyId: string }` y `findUnresolvedEntries(mode: TradingMode, exec?): Promise<UnresolvedEntry[]>` (status `pending`/`pending_execution`, **con filtro de frescura** `created_at < now() - interval '5 minutes'`, sin posición para su decisión).
  - `hasUnresolvedEntryForSetup(strategyId: string, symbol: string, mode: TradingMode, exec?): Promise<boolean>` (**sin** filtro de frescura — es para el gate).
  - `interface BracketLeg { id: string; purpose: 'sl' | 'tp'; exchangeOrderId: string | null; status: string }` y `getBracketLegs(decisionId: string, exec?): Promise<BracketLeg[]>`.
  - `interface ReconcilePosition { id: string; symbol: string; strategyId: string; decisionId: string | null; entry: number; size: number; sl: number; tp: number; entryFee: number }` y `findUnprotectedPositions(mode, exec?): Promise<ReconcilePosition[]>` (status open, protected=false) y `getProtectedOpenPositions(mode, exec?): Promise<ReconcilePosition[]>` (status open, protected=true).

**Contexto:** join verificado: `orders.decision_id → decisions.id → signals (symbol, strategy_id)`. `kairos.orders` no tiene columna `symbol`; se obtiene por join.

- [ ] **Step 1: Escribe el test de integración (falla)**

`src/db/repositories/sp13-reads.test.ts` (sigue el patrón de los `*.integration`/`*-e2e` existentes: inserta filas con SQL directo y verifica los reads). Cubre: `getFillsForOrder` devuelve los fills de una orden; `findUnresolvedEntries` **incluye** una entrada `pending_execution` vieja sin posición y **excluye** (a) una fresca (`created_at = now()`), (b) una con posición para su decisión; `hasUnresolvedEntryForSetup` true para una `pending` **fresca** (sin filtro de frescura); `getBracketLegs` devuelve sl/tp con su `exchange_order_id`; `findUnprotectedPositions`/`getProtectedOpenPositions` filtran por `protected`.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../pool.ts';
import { ulid } from 'ulidx';
import { getFillsForOrder } from './fills.ts';
import { findUnresolvedEntries, hasUnresolvedEntryForSetup, getBracketLegs } from './orders.ts';
import { findUnprotectedPositions, getProtectedOpenPositions } from './positions.ts';

// Helpers mínimos para sembrar el grafo strategy→signal→decision→order/position.
async function seedStrategy(): Promise<string> {
  const id = ulid();
  // FIX H-1 (plan-review): kairos.strategies NO tiene columna `name`; `timeframe` es NOT NULL.
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, trigger_config, risk_params)
               VALUES ($1, true, '15m', '{}'::jsonb, '{}'::jsonb)`, [id]);
  return id;
}
async function seedSignal(strategyId: string, symbol: string): Promise<string> {
  const id = ulid();
  await query(`INSERT INTO kairos.signals (id, strategy_id, symbol, indicator_snapshot) VALUES ($1, $2, $3, '{}'::jsonb)`, [id, strategyId, symbol]);
  return id;
}
async function seedDecision(signalId: string): Promise<string> {
  const id = ulid();
  await query(`INSERT INTO kairos.decisions (id, signal_id, verdict) VALUES ($1, $2, '{}'::jsonb)`, [id, signalId]);
  return id;
}

describe('SP13 reads (integración)', () => {
  beforeEach(async () => {
    // Aísla: limpia el grafo de prueba. (Sigue el patrón de aislamiento de los tests de integración existentes.)
    await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT id FROM kairos.orders WHERE mode = 'testnet')`);
    await query(`DELETE FROM kairos.orders WHERE mode = 'testnet'`);
    await query(`DELETE FROM kairos.positions WHERE mode = 'testnet'`);
  });

  it('getFillsForOrder devuelve los fills de la orden', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    const oid = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'filled', 'testnet')`, [oid, sig, d]);
    await query(`INSERT INTO kairos.fills (id, order_id, price, qty, fee) VALUES ($1, $2, 100, 0.5, 0.05)`, [ulid(), oid]);
    const fills = await getFillsForOrder(oid);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ price: 100, qty: 0.5, fee: 0.05 });
  });

  it('findUnresolvedEntries: incluye vieja-sin-posición; excluye fresca (H1) y vieja-con-posición (idempotencia)', async () => {
    const s = await seedStrategy();
    // (a) vieja sin posición → DEBE aparecer.
    const sigA = await seedSignal(s, 'BTC/USDT'); const dA = await seedDecision(sigA);
    const oldId = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending_execution', 'testnet', now() - interval '10 minutes')`, [oldId, sigA, dA]);
    // (b) fresca (dentro de la ventana del lock) → NO debe aparecer (FIX H1).
    const sigB = await seedSignal(s, 'ETH/USDT'); const dB = await seedDecision(sigB);
    const freshOrderId = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending', 'testnet', now())`, [freshOrderId, sigB, dB]);
    // (c) vieja PERO con posición ya abierta para su decisión → NO debe aparecer (idempotencia A.1).
    const sigC = await seedSignal(s, 'SOL/USDT'); const dC = await seedDecision(sigC);
    const withPosId = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending_execution', 'testnet', now() - interval '10 minutes')`, [withPosId, sigC, dC]);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, decision_id, protected)
                 VALUES ($1, 'SOL/USDT', 'long', 1, 1, 0.9, 1.1, 'open', $2, 'testnet', $3, false)`, [ulid(), s, dC]);

    const ids = (await findUnresolvedEntries('testnet')).map((e) => e.id);
    expect(ids).toContain(oldId);             // (a) sí
    expect(ids).not.toContain(freshOrderId);  // (b) no — filtro de frescura (compara IDs de ORDEN, no de señal)
    expect(ids).not.toContain(withPosId);     // (c) no — ya tiene posición
  });

  it('hasUnresolvedEntryForSetup es true para una pending FRESCA (sin filtro de frescura — gate)', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending_execution', 'testnet', now())`, [ulid(), sig, d]);
    expect(await hasUnresolvedEntryForSetup(s, 'BTC/USDT', 'testnet')).toBe(true);
    expect(await hasUnresolvedEntryForSetup(s, 'SOL/USDT', 'testnet')).toBe(false);
  });

  it('getBracketLegs devuelve sl/tp con exchange_order_id', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    const parent = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'filled', 'testnet')`, [parent, sig, d]);
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, parent_id, status, mode, exchange_order_id)
                 VALUES ($1, $2, $3, 'sell', 1, 'stop_loss_limit', 'sl', $4, 'pending', 'testnet', 'X-SL')`, [ulid(), `${sig}:sl`, d, parent]);
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, parent_id, status, mode, exchange_order_id)
                 VALUES ($1, $2, $3, 'sell', 1, 'take_profit_limit', 'tp', $4, 'pending', 'testnet', 'X-TP')`, [ulid(), `${sig}:tp`, d, parent]);
    const legs = await getBracketLegs(d);
    expect(legs.map((l) => l.purpose).sort()).toEqual(['sl', 'tp']);
    expect(legs.find((l) => l.purpose === 'sl')?.exchangeOrderId).toBe('X-SL');
  });

  it('findUnprotectedPositions / getProtectedOpenPositions filtran por protected', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, decision_id, protected)
                 VALUES ($1, 'BTC/USDT', 'long', 100, 0.5, 95, 110, 'open', $2, 'testnet', $3, false)`, [ulid(), s, d]);
    const sig2 = await seedSignal(s, 'ETH/USDT'); const d2 = await seedDecision(sig2);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, decision_id, protected)
                 VALUES ($1, 'ETH/USDT', 'long', 50, 1, 47, 56, 'open', $2, 'testnet', $3, true)`, [ulid(), s, d2]);
    expect((await findUnprotectedPositions('testnet')).map((p) => p.symbol)).toEqual(['BTC/USDT']);
    expect((await getProtectedOpenPositions('testnet')).map((p) => p.symbol)).toEqual(['ETH/USDT']);
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/db/repositories/sp13-reads.test.ts`
Expected: FAIL (funciones no existen). Requiere `DATABASE_URL` (Postgres del compose); si `docker compose` no está arriba, `docker compose up -d` primero.

- [ ] **Step 3: Implementa `getFillsForOrder`**

En `src/db/repositories/fills.ts`, añade:
```typescript
// SP13: lee los fills de una orden (P&L y detección de fills ya registrados). Auxiliar, NO es el
// ancla de idempotencia (esa es la fila de posición; los fills son auditoría best-effort — FIX M2).
export async function getFillsForOrder(orderId: string, exec: Executor = query): Promise<{ price: number; qty: number; fee: number }[]> {
  const rows = await exec<{ price: string; qty: string; fee: string }>(
    `SELECT price, qty, fee FROM kairos.fills WHERE order_id = $1 ORDER BY ts`,
    [orderId],
  );
  return rows.map((r) => ({ price: Number(r.price), qty: Number(r.qty), fee: Number(r.fee) }));
}
```

- [ ] **Step 4: Implementa los finders de `orders.ts`**

En `src/db/repositories/orders.ts`, añade:
```typescript
export interface UnresolvedEntry { id: string; idempotencyKey: string; decisionId: string; symbol: string; strategyId: string }

// Entradas inciertas a reconciliar (A.1). Con FILTRO DE FRESCURA (FIX H1): excluye in-flight cuya
// ventana de lock (SETUP_LOCK_TTL_MS) aún no expiró, para no pisar al executor. Sin posición para su decisión.
export async function findUnresolvedEntries(mode: TradingMode, exec: Executor = query): Promise<UnresolvedEntry[]> {
  const rows = await exec<{ id: string; idempotency_key: string; decision_id: string; symbol: string; strategy_id: string }>(
    `SELECT o.id, o.idempotency_key, o.decision_id, s.symbol, s.strategy_id
       FROM kairos.orders o
       JOIN kairos.decisions d ON d.id = o.decision_id
       JOIN kairos.signals s ON s.id = d.signal_id
      WHERE o.purpose = 'entry' AND o.status IN ('pending', 'pending_execution') AND o.mode = $1
        AND o.created_at < now() - interval '5 minutes'
        AND NOT EXISTS (SELECT 1 FROM kairos.positions p WHERE p.decision_id = o.decision_id)`,
    [mode],
  );
  return rows.map((r) => ({ id: r.id, idempotencyKey: r.idempotency_key, decisionId: r.decision_id, symbol: r.symbol, strategyId: r.strategy_id }));
}

// Gate de dedup (Componente D): ¿hay una entrada sin resolver para el setup? SIN filtro de frescura
// (una pending_execution recién creada debe bloquear B de inmediato — FIX H1).
export async function hasUnresolvedEntryForSetup(strategyId: string, symbol: string, mode: TradingMode, exec: Executor = query): Promise<boolean> {
  const rows = await exec(
    `SELECT 1 FROM kairos.orders o
       JOIN kairos.decisions d ON d.id = o.decision_id
       JOIN kairos.signals s ON s.id = d.signal_id
      WHERE o.purpose = 'entry' AND o.status IN ('pending', 'pending_execution') AND o.mode = $3
        AND s.strategy_id = $1 AND s.symbol = $2 LIMIT 1`,
    [strategyId, symbol, mode],
  );
  return rows.length > 0;
}

export interface BracketLeg { id: string; purpose: 'sl' | 'tp'; exchangeOrderId: string | null; status: string }

// Legs OCO de una decisión (monitor real + reconciler A.2): id en el exchange + estado.
export async function getBracketLegs(decisionId: string, exec: Executor = query): Promise<BracketLeg[]> {
  const rows = await exec<{ id: string; purpose: string; exchange_order_id: string | null; status: string }>(
    `SELECT id, purpose, exchange_order_id, status FROM kairos.orders
      WHERE decision_id = $1 AND purpose IN ('sl', 'tp')`,
    [decisionId],
  );
  return rows.map((r) => ({ id: r.id, purpose: r.purpose as 'sl' | 'tp', exchangeOrderId: r.exchange_order_id, status: r.status }));
}
```

- [ ] **Step 5: Implementa los finders de `positions.ts`**

En `src/db/repositories/positions.ts`, añade:
```typescript
export interface ReconcilePosition {
  id: string; symbol: string; strategyId: string; decisionId: string | null;
  entry: number; size: number; sl: number; tp: number; entryFee: number;
}

interface ReconcilePositionRow {
  id: string; symbol: string; strategy_id: string; decision_id: string | null;
  entry: string; size: string; sl: string; tp: string; entry_fee: string;
}

function mapReconcilePosition(r: ReconcilePositionRow): ReconcilePosition {
  return { id: r.id, symbol: r.symbol, strategyId: r.strategy_id, decisionId: r.decision_id,
    entry: Number(r.entry), size: Number(r.size), sl: Number(r.sl), tp: Number(r.tp), entryFee: Number(r.entry_fee) };
}

// Posiciones abiertas desprotegidas (reconciler A.2). protected=false = OCO no confirmado.
export async function findUnprotectedPositions(mode: TradingMode, exec: Executor = query): Promise<ReconcilePosition[]> {
  const rows = await exec<ReconcilePositionRow>(
    `SELECT id, symbol, strategy_id, decision_id, entry, size, sl, tp, entry_fee
       FROM kairos.positions WHERE status = 'open' AND mode = $1 AND protected = false`,
    [mode],
  );
  return rows.map(mapReconcilePosition);
}

// Posiciones abiertas protegidas (monitor real). protected=true = OCO residente confirmado.
export async function getProtectedOpenPositions(mode: TradingMode, exec: Executor = query): Promise<ReconcilePosition[]> {
  const rows = await exec<ReconcilePositionRow>(
    `SELECT id, symbol, strategy_id, decision_id, entry, size, sl, tp, entry_fee
       FROM kairos.positions WHERE status = 'open' AND mode = $1 AND protected = true`,
    [mode],
  );
  return rows.map(mapReconcilePosition);
}
```

- [ ] **Step 6: Corre el test de integración, verifica verde**

Run: `npm test -- src/db/repositories/sp13-reads.test.ts`
Expected: PASS (5/5).

- [ ] **Step 7: Commit**

```bash
git add src/db/repositories/fills.ts src/db/repositories/orders.ts src/db/repositories/positions.ts src/db/repositories/sp13-reads.test.ts
git commit -m "feat: lecturas de repo para SP13 (getFillsForOrder, finders reconciler con frescura, getBracketLegs)"
```

---

## Task 4: Gate de dedup setup-aware (`isSetupOccupied`) — cierra I1 por seguridad (Componente D)

**Files:**
- Create: `src/lib/execution/setup-occupied.ts`
- Create: `src/lib/execution/setup-occupied.test.ts`
- Modify: `src/orchestration/evaluate-candidate.ts:17,66` (pre-check)
- Modify: `src/lib/execution/execute-order-real.ts:4,45,49` (re-check dentro del lock)

**Interfaces:**
- Consumes: `hasOpenPositionForSetup` (positions.ts), `hasUnresolvedEntryForSetup` (orders.ts, Task 3).
- Produces: `isSetupOccupied(strategyId: string, symbol: string, mode: TradingMode): Promise<boolean>` = open position **OR** unresolved entry.

- [ ] **Step 1: Escribe el test (falla)**

`src/lib/execution/setup-occupied.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/positions.ts', () => ({ hasOpenPositionForSetup: vi.fn() }));
vi.mock('../../db/repositories/orders.ts', () => ({ hasUnresolvedEntryForSetup: vi.fn() }));

import { hasOpenPositionForSetup } from '../../db/repositories/positions.ts';
import { hasUnresolvedEntryForSetup } from '../../db/repositories/orders.ts';
import { isSetupOccupied } from './setup-occupied.ts';

beforeEach(() => { vi.clearAllMocks(); });

describe('isSetupOccupied', () => {
  it('true si hay posición abierta (corta-circuito, no consulta órdenes)', async () => {
    vi.mocked(hasOpenPositionForSetup).mockResolvedValue(true);
    expect(await isSetupOccupied('s', 'BTC/USDT', 'testnet')).toBe(true);
    expect(hasUnresolvedEntryForSetup).not.toHaveBeenCalled();
  });

  it('true si hay entrada sin resolver (aunque no haya posición)', async () => {
    vi.mocked(hasOpenPositionForSetup).mockResolvedValue(false);
    vi.mocked(hasUnresolvedEntryForSetup).mockResolvedValue(true);
    expect(await isSetupOccupied('s', 'BTC/USDT', 'testnet')).toBe(true);
  });

  it('false si no hay ni posición ni entrada sin resolver', async () => {
    vi.mocked(hasOpenPositionForSetup).mockResolvedValue(false);
    vi.mocked(hasUnresolvedEntryForSetup).mockResolvedValue(false);
    expect(await isSetupOccupied('s', 'BTC/USDT', 'testnet')).toBe(false);
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/execution/setup-occupied.test.ts`
Expected: FAIL ("Cannot find module './setup-occupied.ts'").

- [ ] **Step 3: Implementa `isSetupOccupied`**

`src/lib/execution/setup-occupied.ts`:
```typescript
import { hasOpenPositionForSetup } from '../../db/repositories/positions.ts';
import { hasUnresolvedEntryForSetup } from '../../db/repositories/orders.ts';
import type { TradingMode } from '../mode.ts';

// Gate de dedup setup-aware (SP13, Componente D): un setup está ocupado si tiene una posición abierta
// O una entrada sin resolver (pending/pending_execution). Esto cierra la doble-compra I1 POR SEGURIDAD,
// independiente de la cadencia del reconciler. Corta-circuito: la posición abierta es el caso común.
export async function isSetupOccupied(strategyId: string, symbol: string, mode: TradingMode): Promise<boolean> {
  if (await hasOpenPositionForSetup(strategyId, symbol, mode)) return true;
  return hasUnresolvedEntryForSetup(strategyId, symbol, mode);
}
```

- [ ] **Step 4: Corre el test, verifica verde**

Run: `npm test -- src/lib/execution/setup-occupied.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Cablea el pre-check en `evaluate-candidate.ts`**

En `src/orchestration/evaluate-candidate.ts`: cambia el import de la línea 17 y el pre-check de la línea 66.
- Línea 17 — reemplaza `import { hasOpenPositionForSetup } from '../db/repositories/positions.ts';` por:
```typescript
import { isSetupOccupied } from '../lib/execution/setup-occupied.ts';
```
- Línea 66 — reemplaza `if (await hasOpenPositionForSetup(signal.strategyId, signal.symbol, mode)) {` por:
```typescript
  if (await isSetupOccupied(signal.strategyId, signal.symbol, mode)) {
```

- [ ] **Step 6: Cablea el re-check dentro del lock en `execute-order-real.ts`**

En `src/lib/execution/execute-order-real.ts`:
- Línea 4 — el import de `hasOpenPositionForSetup` ya viene de positions.ts junto a otros; **añade** un import del gate:
```typescript
import { isSetupOccupied } from './setup-occupied.ts';
```
- Línea 45 — reemplaza `const hasOpen = deps.hasOpenForSetup ?? hasOpenPositionForSetup;` por:
```typescript
  const hasOpen = deps.hasOpenForSetup ?? isSetupOccupied;
```
(El tipo de `deps.hasOpenForSetup` ya es `typeof hasOpenPositionForSetup`, que tiene la misma firma `(strategyId, symbol, mode) => Promise<boolean>` que `isSetupOccupied` — compatible.) La línea 49 (`if (await hasOpen(...))`) no cambia. Si `hasOpenPositionForSetup` queda sin uso en el import, quítalo de la lista de imports de positions.ts en este archivo.

- [ ] **Step 7: Corre los tests afectados, verifica verde**

Run: `npm test -- src/lib/execution/setup-occupied.test.ts src/lib/execution/execute-order-real.test.ts src/orchestration/`
Expected: PASS. Si algún test de `evaluate-candidate`/`execute-order-real` mockeaba `hasOpenPositionForSetup`, re-apúntalo a `isSetupOccupied` (mismo contrato booleano).

- [ ] **Step 8: typecheck**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 9: Commit**

```bash
git add src/lib/execution/setup-occupied.ts src/lib/execution/setup-occupied.test.ts src/orchestration/evaluate-candidate.ts src/lib/execution/execute-order-real.ts
git commit -m "feat: gate de dedup setup-aware (isSetupOccupied) — cierra I1 por seguridad (SP13 Componente D)"
```

---

## Task 5: Reconciler A.1 — entradas inciertas (`exchange-reconcile.ts` parte 1)

**Files:**
- Create: `src/lib/reconcile/exchange-reconcile.ts`
- Create: `src/lib/reconcile/exchange-reconcile.test.ts`

**Interfaces:**
- Consumes: `findUnresolvedEntries`, `getFillsForOrder`, `updateOrderStatus`, `setOrderExchangeId`, `insertBracketLeg`, `claimEntryOrder`(no), `openPosition`, `setPositionProtected`, `insertFill`, `appendAuditLog` (repos); `fetchEntryState`, `fetchExitFromTrades` (order-state); `placeOco` (place-oco); `entryClientOrderId`. `RealClient`.
- Produces: `interface ReconcileDepsReal { client; placeOco; emergencyClose; mode }` y `reconcileUnresolvedEntries(deps): Promise<{ resolved: number }>`. (El orquestador `runExchangeReconcile` y A.2 se añaden en Task 6.)

**Contexto:** A.1 resuelve cada entrada incierta. Llenada → abre posición (protected=false, idempotente por el índice parcial) → registra fill → re-protege (placeOco) → protected=true → orden filled. No-llenada/no-existe → orden canceled. Best-effort por ítem.

- [ ] **Step 1: Escribe los tests (fallan)**

`src/lib/reconcile/exchange-reconcile.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/orders.ts', () => ({
  findUnresolvedEntries: vi.fn(), updateOrderStatus: vi.fn(), setOrderExchangeId: vi.fn(), insertBracketLeg: vi.fn(),
}));
vi.mock('../../db/repositories/positions.ts', () => ({ openPosition: vi.fn(), setPositionProtected: vi.fn() }));
vi.mock('../../db/repositories/fills.ts', () => ({ insertFill: vi.fn(), getFillsForOrder: vi.fn(async () => []) }));
vi.mock('../../db/repositories/decisions.ts', () => ({ getDecisionVerdict: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));
vi.mock('../execution/real-order/order-state.ts', () => ({ fetchEntryState: vi.fn(), fetchExitFromTrades: vi.fn() }));

import { findUnresolvedEntries, updateOrderStatus, setOrderExchangeId } from '../../db/repositories/orders.ts';
import { openPosition, setPositionProtected } from '../../db/repositories/positions.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getDecisionVerdict } from '../../db/repositories/decisions.ts';
import { fetchEntryState, fetchExitFromTrades } from '../execution/real-order/order-state.ts';
import { reconcileUnresolvedEntries } from './exchange-reconcile.ts';

const baseEntry = { id: 'o1', idempotencyKey: 'sig-1', decisionId: 'd1', symbol: 'BTC/USDT', strategyId: 'strat-1' };
function deps(over: Record<string, unknown> = {}) {
  return { client: {} as never, placeOco: vi.fn(async () => ({ orderListId: 'L1', slOrderId: 'SL', tpOrderId: 'TP' })),
    emergencyClose: vi.fn(), mode: 'testnet' as const, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDecisionVerdict).mockResolvedValue({ sl: 95, tp: 110 } as never);
  vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 100, exitFee: 0.05, qty: 0.5 });
});

describe('reconcileUnresolvedEntries', () => {
  it('entrada LLENADA → abre posición + fill + exchangeId real + re-protege + orden filled', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry]);
    vi.mocked(fetchEntryState).mockResolvedValue({ found: true, status: 'closed', filled: 0.5, average: 100, exchangeOrderId: 'BIN-1' });
    vi.mocked(openPosition).mockResolvedValue('p1');
    const d = deps();
    const r = await reconcileUnresolvedEntries(d);
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/USDT', size: 0.5, protected: false }));
    expect(insertFill).toHaveBeenCalled();
    expect(setOrderExchangeId).toHaveBeenCalledWith('o1', 'BIN-1');   // FIX M-2: id real, no el clientOrderId
    expect(d.placeOco).toHaveBeenCalledWith(d.client, expect.objectContaining({ symbol: 'BTC/USDT', qty: 0.5 }));
    expect(setPositionProtected).toHaveBeenCalledWith('p1', true);
    expect(updateOrderStatus).toHaveBeenCalledWith('o1', 'filled');
    expect(r.resolved).toBe(1);
  });

  it('entrada NO LLENADA (found:false) → orden canceled, sin posición', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry]);
    vi.mocked(fetchEntryState).mockResolvedValue({ found: false });
    await reconcileUnresolvedEntries(deps());
    expect(updateOrderStatus).toHaveBeenCalledWith('o1', 'canceled');
    expect(openPosition).not.toHaveBeenCalled();
  });

  it('found pero filled=0 → canceled (no abre posición size 0)', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry]);
    vi.mocked(fetchEntryState).mockResolvedValue({ found: true, status: 'canceled', filled: 0, average: 0 });
    await reconcileUnresolvedEntries(deps());
    expect(updateOrderStatus).toHaveBeenCalledWith('o1', 'canceled');
    expect(openPosition).not.toHaveBeenCalled();
  });

  it('best-effort por ítem: un fallo audita y sigue con el siguiente', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry, { ...baseEntry, id: 'o2', idempotencyKey: 'sig-2', decisionId: 'd2' }]);
    vi.mocked(fetchEntryState).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ found: false });
    const r = await reconcileUnresolvedEntries(deps());
    expect(updateOrderStatus).toHaveBeenCalledWith('o2', 'canceled'); // el segundo se procesó pese al fallo del primero
    expect(r.resolved).toBe(1);
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/reconcile/exchange-reconcile.test.ts`
Expected: FAIL ("Cannot find module './exchange-reconcile.ts'" o `reconcileUnresolvedEntries`/`getDecisionVerdict` no existen).

- [ ] **Step 3: Añade `getDecisionVerdict` a decisions.ts (si no existe)**

El reconciler necesita el `sl`/`tp` de la decisión para re-proteger una entrada que el reconciler abre (la fila de posición aún no existe en A.1). Verifica si `src/db/repositories/decisions.ts` ya expone una lectura del verdict; si no, añade:
```typescript
// SP13: lee el verdict (sl/tp) de una decisión para re-proteger una entrada reconciliada.
export async function getDecisionVerdict(decisionId: string, exec: Executor = query): Promise<{ sl: number; tp: number } | null> {
  const rows = await exec<{ verdict: { sl: number; tp: number } }>(
    `SELECT verdict FROM kairos.decisions WHERE id = $1`, [decisionId],
  );
  const v = rows[0]?.verdict;
  return v ? { sl: Number(v.sl), tp: Number(v.tp) } : null;
}
```
(Importa `query`/`Executor` desde `../pool.ts` si no están ya importados.)

- [ ] **Step 4: Implementa `reconcileUnresolvedEntries`**

`src/lib/reconcile/exchange-reconcile.ts`:
```typescript
import { findUnresolvedEntries, updateOrderStatus, setOrderExchangeId, insertBracketLeg, type UnresolvedEntry } from '../../db/repositories/orders.ts';
import { openPosition, setPositionProtected } from '../../db/repositories/positions.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getDecisionVerdict } from '../../db/repositories/decisions.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { fetchEntryState } from '../execution/real-order/order-state.ts';
import type { RealClient } from '../execution/execute-order-real.ts';
import type { PlaceOcoArgs, OcoResult } from '../execution/real-order/place-oco.ts';
import type { EmergencyArgs, ExitResult } from '../execution/real-order/emergency-close.ts';
import type { TradingMode } from '../mode.ts';

export interface ReconcileDepsReal {
  client: RealClient;
  placeOco: (client: RealClient, a: PlaceOcoArgs) => Promise<OcoResult>;
  emergencyClose: (client: RealClient, a: EmergencyArgs) => Promise<ExitResult>;
  mode: TradingMode;
}

// A.1 — reconcilia entradas inciertas contra el exchange. Best-effort por ítem.
export async function reconcileUnresolvedEntries(deps: ReconcileDepsReal): Promise<{ resolved: number }> {
  const entries = await findUnresolvedEntries(deps.mode);
  let resolved = 0;
  for (const e of entries) {
    try {
      if (await reconcileOneEntry(deps, e)) resolved++;
    } catch (err) {
      await safeAudit('reconcile_entry_error', { orderId: e.id, error: msg(err) });
    }
  }
  return { resolved };
}

async function reconcileOneEntry(deps: ReconcileDepsReal, e: UnresolvedEntry): Promise<boolean> {
  const state = await fetchEntryState(deps.client, e.symbol, e.idempotencyKey);
  if (!state.found || state.filled <= 0) {
    await updateOrderStatus(e.id, 'canceled');
    await appendAuditLog({ eventType: 'reconcile_entry_void', actor: 'reconciler', payload: { orderId: e.id, idem: e.idempotencyKey } });
    return true;
  }
  const verdict = await getDecisionVerdict(e.decisionId);
  if (!verdict) throw new Error(`decisión ${e.decisionId} sin verdict`);
  // Ancla de idempotencia: la fila de posición (índice parcial per-setup). Abre con protected=false.
  const positionId = await openPosition({ symbol: e.symbol, entry: state.average, size: state.filled, sl: verdict.sl,
    tp: verdict.tp, strategyId: e.strategyId, mode: deps.mode, decisionId: e.decisionId, protected: false });
  await insertFill({ orderId: e.id, price: state.average, qty: state.filled, fee: 0 });
  await setOrderExchangeId(e.id, state.exchangeOrderId);   // FIX M-2: id real del exchange, no el clientOrderId
  await updateOrderStatus(e.id, 'filled');
  // Re-protege con OCO residente.
  const oco = await deps.placeOco(deps.client, { symbol: e.symbol, qty: state.filled, sl: verdict.sl, tp: verdict.tp });
  await insertBracketLeg({ idempotencyKey: `${e.idempotencyKey}:sl`, decisionId: e.decisionId, size: state.filled, purpose: 'sl', parentId: e.id, mode: deps.mode, exchangeOrderId: oco.slOrderId });
  await insertBracketLeg({ idempotencyKey: `${e.idempotencyKey}:tp`, decisionId: e.decisionId, size: state.filled, purpose: 'tp', parentId: e.id, mode: deps.mode, exchangeOrderId: oco.tpOrderId });
  await setPositionProtected(positionId, true);
  await appendAuditLog({ eventType: 'reconcile_entry_filled', actor: 'reconciler', payload: { orderId: e.id, positionId, orderListId: oco.orderListId } });
  return true;
}

function msg(err: unknown): string { return err instanceof Error ? err.message : String(err); }
async function safeAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
  try { await appendAuditLog({ eventType, actor: 'reconciler', payload }); } catch { /* último recurso */ }
}
```

> Nota de fee (M1/M2): el fill reconciliado registra `fee: 0` porque la fila de fee no se reconstruye aquí (auditoría best-effort; el P&L canónico se computará al cierre desde los trades reales). Documentado.

- [ ] **Step 5: Corre los tests, verifica verde**

Run: `npm test -- src/lib/reconcile/exchange-reconcile.test.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reconcile/exchange-reconcile.ts src/lib/reconcile/exchange-reconcile.test.ts src/db/repositories/decisions.ts
git commit -m "feat: reconciler A.1 — resuelve entradas inciertas contra el exchange (SP13)"
```

---

## Task 6: Reconciler A.2 — posiciones desprotegidas + orquestador `runExchangeReconcile`

**Files:**
- Modify: `src/lib/reconcile/exchange-reconcile.ts` (+ A.2 + orquestador)
- Modify: `src/lib/reconcile/exchange-reconcile.test.ts` (+ casos A.2 + orquestador)

**Interfaces:**
- Consumes: `findUnprotectedPositions`, `getBracketLegs`, `setPositionProtected`, `closeOpenPosition`, `closeBracketLegs` (repos); `fetchLegState`, `fetchExitFromTrades` (order-state); `placeOco`, `emergencyClose`.
- Produces: `reconcileUnprotectedPositions(deps: ReconcileDepsReal): Promise<{ resolved: number }>` y `runExchangeReconcile(deps: ReconcileDepsReal): Promise<{ entries: number; positions: number }>`.

**Contexto (A.2):** por cada posición open+protected=false, mira sus legs. Sin legs persistidas o legs no vivas → re-protege (placeOco) → protected=true; si placeOco falla → emergencyClose + cierra DB con P&L real. Legs vivas en el exchange → solo protected=true (crash antes del flip). Si las legs muestran que ya cerró en el exchange (una llena) → cierra DB con P&L real de los trades.

- [ ] **Step 1: Añade los tests de A.2 + orquestador (fallan)**

Añade a `src/lib/reconcile/exchange-reconcile.test.ts` (extiende los mocks: `findUnprotectedPositions`, `closeOpenPosition`, `closeBracketLegs`, `getBracketLegs`, `setPositionProtected`, `fetchLegState`):
```typescript
// (añade a los vi.mock de orders/positions/order-state las nuevas fns)
//   orders.ts:    getBracketLegs, closeBracketLegs
//   positions.ts: findUnprotectedPositions, closeOpenPosition
//   order-state:  fetchLegState
import { findUnprotectedPositions, closeOpenPosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs } from '../../db/repositories/orders.ts';
import { fetchLegState } from '../execution/real-order/order-state.ts';
import { reconcileUnprotectedPositions, runExchangeReconcile } from './exchange-reconcile.ts';

const basePos = { id: 'p1', symbol: 'BTC/USDT', strategyId: 'strat-1', decisionId: 'd1', entry: 100, size: 0.5, sl: 95, tp: 110, entryFee: 0.05 };

describe('reconcileUnprotectedPositions', () => {
  it('posición abierta + OCO vivo en el exchange → solo protected=true', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([
      { id: 'sl', purpose: 'sl', exchangeOrderId: 'X-SL', status: 'pending' },
      { id: 'tp', purpose: 'tp', exchangeOrderId: 'X-TP', status: 'pending' },
    ]);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'open', filled: 0 });
    await reconcileUnprotectedPositions(deps());
    expect(setPositionProtected).toHaveBeenCalledWith('p1', true);
    expect(closeOpenPosition).not.toHaveBeenCalled();
  });

  it('posición cerrada en el exchange (una leg llena) → cierra DB con P&L real', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([
      { id: 'sl', purpose: 'sl', exchangeOrderId: 'X-SL', status: 'pending' },
      { id: 'tp', purpose: 'tp', exchangeOrderId: 'X-TP', status: 'pending' },
    ]);
    vi.mocked(fetchLegState).mockImplementation(async (_c, _s, legId) =>
      legId === 'X-TP' ? { status: 'closed', filled: 0.5 } : { status: 'canceled', filled: 0 });
    vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 110, exitFee: 0.06, qty: 0.5 });
    vi.mocked(closeOpenPosition).mockResolvedValue(true);
    await reconcileUnprotectedPositions(deps());
    // realizedPnl = (110-100)*0.5 - 0.06 - 0.05 = 4.89
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(4.89, 6), expect.any(Date));
    expect(closeBracketLegs).toHaveBeenCalledWith('d1', 'tp');
  });

  it('posición abierta SIN OCO vivo → re-protege (placeOco) y protected=true', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([]); // sin legs persistidas
    const d = deps();
    await reconcileUnprotectedPositions(d);
    expect(d.placeOco).toHaveBeenCalledWith(d.client, expect.objectContaining({ symbol: 'BTC/USDT', qty: 0.5, sl: 95, tp: 110 }));
    expect(setPositionProtected).toHaveBeenCalledWith('p1', true);
  });

  it('re-protección falla → cierre de emergencia + cierra DB con P&L real', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([]);
    vi.mocked(closeOpenPosition).mockResolvedValue(true);
    const d = deps({ placeOco: vi.fn(async () => { throw new Error('oco down'); }),
      emergencyClose: vi.fn(async () => ({ exitPrice: 96, exitFee: 0.05, exchangeOrderId: 'EM' })) });
    await reconcileUnprotectedPositions(d);
    expect(d.emergencyClose).toHaveBeenCalled();
    // realizedPnl = (96-100)*0.5 - 0.05 - 0.05 = -2.10
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(-2.10, 6), expect.any(Date));
  });
});

describe('runExchangeReconcile', () => {
  it('corre A.1 y A.2 y devuelve los conteos', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([]);
    vi.mocked(findUnprotectedPositions).mockResolvedValue([]);
    expect(await runExchangeReconcile(deps())).toEqual({ entries: 0, positions: 0 });
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/reconcile/exchange-reconcile.test.ts`
Expected: FAIL (`reconcileUnprotectedPositions`/`runExchangeReconcile` no existen).

- [ ] **Step 3: Implementa A.2 + orquestador**

Añade a `src/lib/reconcile/exchange-reconcile.ts` (y extiende los imports: `findUnprotectedPositions`, `closeOpenPosition`, `type ReconcilePosition` de positions.ts; `getBracketLegs`, `closeBracketLegs`, `type BracketLeg` de orders.ts; `fetchLegState`, `fetchExitFromTrades` de order-state):
```typescript
// A.2 — reconcilia posiciones abiertas desprotegidas. Best-effort por ítem.
export async function reconcileUnprotectedPositions(deps: ReconcileDepsReal): Promise<{ resolved: number }> {
  const positions = await findUnprotectedPositions(deps.mode);
  let resolved = 0;
  for (const p of positions) {
    try { if (await reconcileOnePosition(deps, p)) resolved++; }
    catch (err) { await safeAudit('reconcile_position_error', { positionId: p.id, error: msg(err) }); }
  }
  return { resolved };
}

async function reconcileOnePosition(deps: ReconcileDepsReal, p: ReconcilePosition): Promise<boolean> {
  const legs = (await getBracketLegs(p.decisionId ?? '')).filter((l) => l.exchangeOrderId);
  const states = await Promise.all(legs.map(async (l) => ({ leg: l, st: await fetchLegState(deps.client, p.symbol, l.exchangeOrderId as string) })));
  const filled = states.find((s) => s.st.filled > 0 && (s.st.status === 'closed' || s.st.status === 'filled'));
  if (filled) return closePositionFromExchange(deps, p, filled.leg);
  const liveLegs = states.some((s) => s.st.status === 'open');
  if (liveLegs) { // OCO vivo: el crash fue antes del flip de protected
    await setPositionProtected(p.id, true);
    await appendAuditLog({ eventType: 'reconcile_reprotected_noop', actor: 'reconciler', payload: { positionId: p.id } });
    return true;
  }
  return reprotectOrFlatten(deps, p); // sin OCO vivo → re-protege o aplana
}

async function closePositionFromExchange(deps: ReconcileDepsReal, p: ReconcilePosition, leg: BracketLeg): Promise<boolean> {
  const exit = await fetchExitFromTrades(deps.client, p.symbol, leg.exchangeOrderId as string);
  const realized = (exit.exitPrice - p.entry) * p.size - exit.exitFee - p.entryFee;
  const closed = await closeOpenPosition(p.id, realized, new Date());
  if (closed && p.decisionId) await closeBracketLegs(p.decisionId, leg.purpose);
  await appendAuditLog({ eventType: 'reconcile_position_closed', actor: 'reconciler', payload: { positionId: p.id, realized } });
  return closed;
}

async function reprotectOrFlatten(deps: ReconcileDepsReal, p: ReconcilePosition): Promise<boolean> {
  try {
    const oco = await deps.placeOco(deps.client, { symbol: p.symbol, qty: p.size, sl: p.sl, tp: p.tp });
    if (p.decisionId) {
      await insertBracketLeg({ idempotencyKey: `${p.id}:sl`, decisionId: p.decisionId, size: p.size, purpose: 'sl', parentId: p.id, mode: deps.mode, exchangeOrderId: oco.slOrderId });
      await insertBracketLeg({ idempotencyKey: `${p.id}:tp`, decisionId: p.decisionId, size: p.size, purpose: 'tp', parentId: p.id, mode: deps.mode, exchangeOrderId: oco.tpOrderId });
    }
    await setPositionProtected(p.id, true);
    await appendAuditLog({ eventType: 'reconcile_reprotected', actor: 'reconciler', payload: { positionId: p.id, orderListId: oco.orderListId } });
    return true;
  } catch {
    const exit = await deps.emergencyClose(deps.client, { symbol: p.symbol, qty: p.size });
    const realized = (exit.exitPrice - p.entry) * p.size - exit.exitFee - p.entryFee;
    const closed = await closeOpenPosition(p.id, realized, new Date());
    await appendAuditLog({ eventType: 'reconcile_reprotect_emergency', actor: 'reconciler', payload: { positionId: p.id, realized } });
    return closed;
  }
}

// Orquestador: A.1 (entradas) + A.2 (posiciones). Arranque y tick periódico llaman esto.
export async function runExchangeReconcile(deps: ReconcileDepsReal): Promise<{ entries: number; positions: number }> {
  const a1 = await reconcileUnresolvedEntries(deps);
  const a2 = await reconcileUnprotectedPositions(deps);
  return { entries: a1.resolved, positions: a2.resolved };
}
```

- [ ] **Step 4: Corre los tests, verifica verde**

Run: `npm test -- src/lib/reconcile/exchange-reconcile.test.ts`
Expected: PASS (todos: A.1 + A.2 + orquestador).

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reconcile/exchange-reconcile.ts src/lib/reconcile/exchange-reconcile.test.ts
git commit -m "feat: reconciler A.2 (posiciones desprotegidas: re-protege/aplana/cierra) + orquestador runExchangeReconcile (SP13)"
```

---

## Task 7: Monitor de cierres reales (`monitor-real.ts`) — close-first + handoff M3 (Componente B)

**Files:**
- Create: `src/lib/monitor/monitor-real.ts`
- Create: `src/lib/monitor/monitor-real.test.ts`

**Interfaces:**
- Consumes: `getProtectedOpenPositions`, `setPositionProtected`, `closeOpenPosition` (positions.ts); `getBracketLegs`, `closeBracketLegs` (orders.ts); `insertFill` (fills.ts); `fetchLegState`, `fetchExitFromTrades` (order-state); `appendAuditLog`, `notifyBestEffort`; `RealClient`.
- Produces: `interface MonitorRealDeps { client: RealClient; mode: TradingMode; notify: (text: string) => Promise<{ messageId: string | null }> }` y `runMonitorTickReal(asOf: Date, deps: MonitorRealDeps): Promise<{ checked: number; closed: number }>`.

**Contexto:** por cada posición protegida, mira sus legs. Leg llena → **close-first** (closeOpenPosition primero; solo si true → fill + closeBracketLegs + notify). Ambas terminales sin fill → `setPositionProtected(false)` (handoff M3 al reconciler). Ambas abiertas → nada. Best-effort por posición.

- [ ] **Step 1: Escribe los tests (fallan)**

`src/lib/monitor/monitor-real.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/positions.ts', () => ({ getProtectedOpenPositions: vi.fn(), setPositionProtected: vi.fn(), closeOpenPosition: vi.fn() }));
vi.mock('../../db/repositories/orders.ts', () => ({ getBracketLegs: vi.fn(), closeBracketLegs: vi.fn() }));
vi.mock('../../db/repositories/fills.ts', () => ({ insertFill: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));
vi.mock('../execution/real-order/order-state.ts', () => ({ fetchLegState: vi.fn(), fetchExitFromTrades: vi.fn() }));

import { getProtectedOpenPositions, setPositionProtected, closeOpenPosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { fetchLegState, fetchExitFromTrades } from '../execution/real-order/order-state.ts';
import { runMonitorTickReal } from './monitor-real.ts';

const pos = { id: 'p1', symbol: 'BTC/USDT', strategyId: 's', decisionId: 'd1', entry: 100, size: 0.5, sl: 95, tp: 110, entryFee: 0.05 };
function deps() { return { client: {} as never, mode: 'testnet' as const, notify: vi.fn(async () => ({ messageId: 'm' })) }; }
const legs = [
  { id: 'sl', purpose: 'sl' as const, exchangeOrderId: 'X-SL', status: 'pending' },
  { id: 'tp', purpose: 'tp' as const, exchangeOrderId: 'X-TP', status: 'pending' },
];

beforeEach(() => { vi.clearAllMocks(); vi.mocked(getBracketLegs).mockResolvedValue(legs); });

describe('runMonitorTickReal', () => {
  it('leg TP llena → close-first → fill + closeBracketLegs + notify', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockImplementation(async (_c, _s, id) => id === 'X-TP' ? { status: 'closed', filled: 0.5 } : { status: 'canceled', filled: 0 });
    vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 110, exitFee: 0.06, qty: 0.5 });
    vi.mocked(closeOpenPosition).mockResolvedValue(true);
    const r = await runMonitorTickReal(new Date(), deps());
    // close-first: closeOpenPosition ANTES de insertFill
    expect(vi.mocked(closeOpenPosition).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(insertFill).mock.invocationCallOrder[0]);
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(4.89, 6), expect.any(Date));
    expect(closeBracketLegs).toHaveBeenCalledWith('d1', 'tp');
    expect(r.closed).toBe(1);
  });

  it('close-first idempotente: si closeOpenPosition devuelve false (otro tick ya cerró) → NO inserta fill', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockImplementation(async (_c, _s, id) => id === 'X-TP' ? { status: 'closed', filled: 0.5 } : { status: 'canceled', filled: 0 });
    vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 110, exitFee: 0.06, qty: 0.5 });
    vi.mocked(closeOpenPosition).mockResolvedValue(false);
    const r = await runMonitorTickReal(new Date(), deps());
    expect(insertFill).not.toHaveBeenCalled();
    expect(r.closed).toBe(0);
  });

  it('ambas legs terminales sin fill → handoff M3 (protected=false), no cierra', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'canceled', filled: 0 });
    await runMonitorTickReal(new Date(), deps());
    expect(setPositionProtected).toHaveBeenCalledWith('p1', false);
    expect(closeOpenPosition).not.toHaveBeenCalled();
  });

  it('ambas legs abiertas → nada', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'open', filled: 0 });
    const r = await runMonitorTickReal(new Date(), deps());
    expect(setPositionProtected).not.toHaveBeenCalled();
    expect(closeOpenPosition).not.toHaveBeenCalled();
    expect(r.closed).toBe(0);
  });

  it('best-effort: un fallo de posición audita y el tick sigue', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos, { ...pos, id: 'p2', decisionId: 'd2' }]);
    vi.mocked(fetchLegState).mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ status: 'open', filled: 0 });
    const r = await runMonitorTickReal(new Date(), deps());
    expect(r.checked).toBe(2); // ambas chequeadas pese al fallo
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/monitor/monitor-real.test.ts`
Expected: FAIL ("Cannot find module './monitor-real.ts'").

- [ ] **Step 3: Implementa `runMonitorTickReal`**

`src/lib/monitor/monitor-real.ts`:
```typescript
import { getProtectedOpenPositions, setPositionProtected, closeOpenPosition, type ReconcilePosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs, type BracketLeg } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { notifyBestEffort } from '../../notify/best-effort.ts';
import { fetchLegState, fetchExitFromTrades } from '../execution/real-order/order-state.ts';
import type { RealClient } from '../execution/execute-order-real.ts';
import type { TradingMode } from '../mode.ts';

export interface MonitorRealDeps {
  client: RealClient;
  mode: TradingMode;
  notify: (text: string) => Promise<{ messageId: string | null }>;
}

const TERMINAL = new Set(['canceled', 'expired', 'rejected']);
const FILLED = new Set(['closed', 'filled']);

// Monitor de cierres reales (testnet/live): detecta el fill server-side del OCO vía polling REST.
// Best-effort por posición. NO resuelve velas (el OCO es la autoridad).
export async function runMonitorTickReal(asOf: Date, deps: MonitorRealDeps): Promise<{ checked: number; closed: number }> {
  const positions = await getProtectedOpenPositions(deps.mode);
  let checked = 0, closed = 0;
  for (const p of positions) {
    checked++;
    try { if (await checkOne(deps, p, asOf)) closed++; }
    catch (err) {
      try { await appendAuditLog({ eventType: 'monitor_error', actor: 'monitor-real', payload: { positionId: p.id, error: err instanceof Error ? err.message : String(err) } }); }
      catch { /* último recurso */ }
    }
  }
  return { checked, closed };
}

async function checkOne(deps: MonitorRealDeps, p: ReconcilePosition, asOf: Date): Promise<boolean> {
  const legs = (await getBracketLegs(p.decisionId ?? '')).filter((l) => l.exchangeOrderId);
  if (legs.length === 0) { await handoff(p); return false; } // sin legs vivas → al reconciler
  const states = await Promise.all(legs.map(async (l) => ({ leg: l, st: await fetchLegState(deps.client, p.symbol, l.exchangeOrderId as string) })));
  const hit = states.find((s) => s.st.filled > 0 && FILLED.has(s.st.status));
  if (hit) return closeFromLeg(deps, p, hit.leg, asOf);
  if (states.every((s) => TERMINAL.has(s.st.status))) { await handoff(p); return false; } // OCO muerto (gap L1)
  return false; // alguna leg sigue viva → nada
}

// FIX H2 (close-first): cierra la posición ANTES de insertar el fill. Si otro tick ya la cerró
// (closeOpenPosition=false), no duplica el fill ni re-cierra legs.
async function closeFromLeg(deps: MonitorRealDeps, p: ReconcilePosition, leg: BracketLeg, asOf: Date): Promise<boolean> {
  const exit = await fetchExitFromTrades(deps.client, p.symbol, leg.exchangeOrderId as string);
  const realized = (exit.exitPrice - p.entry) * p.size - exit.exitFee - p.entryFee;
  const closed = await closeOpenPosition(p.id, realized, asOf);
  if (!closed) return false;
  await insertFill({ orderId: leg.id, price: exit.exitPrice, qty: exit.qty, fee: exit.exitFee });
  if (p.decisionId) await closeBracketLegs(p.decisionId, leg.purpose);
  await appendAuditLog({ eventType: 'position_closed_real', actor: 'monitor-real', payload: { positionId: p.id, hitType: leg.purpose, exitPrice: exit.exitPrice, realized } });
  const icon = leg.purpose === 'tp' ? '🟢' : '🔴';
  await notifyBestEffort(deps.notify, `${icon} ${p.symbol}: salida ${leg.purpose.toUpperCase()} @ ${exit.exitPrice} (pnl ${realized.toFixed(2)})`, 'monitor-real');
  return true;
}

// Handoff M3: OCO muerto/ausente sobre posición protegida → protected=false → reconciler A.2.
async function handoff(p: ReconcilePosition): Promise<void> {
  await setPositionProtected(p.id, false);
  await appendAuditLog({ eventType: 'monitor_oco_dead', actor: 'monitor-real', payload: { positionId: p.id } });
}
```

- [ ] **Step 4: Corre los tests, verifica verde**

Run: `npm test -- src/lib/monitor/monitor-real.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/monitor/monitor-real.ts src/lib/monitor/monitor-real.test.ts
git commit -m "feat: monitor de cierres reales (close-first idempotente + handoff M3) — SP13 Componente B"
```

---

## Task 8: Frescura OHLCV (`refresh.ts`) — Componente C

**Files:**
- Create: `src/lib/market-data/refresh.ts`
- Create: `src/lib/market-data/refresh.test.ts`

**Interfaces:**
- Consumes: `SYMBOLS`, `TIMEFRAMES`, `FETCH_LIMIT` (config.ts); `getLatestOpenTime`, `upsertCandles` (ohlcv-candles.ts); `fetchClosedOHLCV` (ohlcv.ts); `createPublicClient` (ccxt-client.ts); `appendAuditLog`.
- Produces: `interface RefreshOhlcvDeps { client: Pick<Exchange, 'loadMarkets' | 'fetchOHLCV'>; now?: () => number }` y `refreshOhlcv(deps?: Partial<RefreshOhlcvDeps>): Promise<{ upserted: number }>`.

**Contexto:** por cada `symbol×timeframe`, lee `getLatestOpenTime` (Date|null → ms; si null usa `now - 2*TF` para no pedir histórico completo), `fetchClosedOHLCV`, `upsertCandles`. **FIX L3:** `loadMarkets()` una vez antes del primer fetch. Best-effort por símbolo.

- [ ] **Step 1: Escribe los tests (fallan)**

`src/lib/market-data/refresh.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/ohlcv-candles.ts', () => ({ getLatestOpenTime: vi.fn(), upsertCandles: vi.fn() }));
vi.mock('./ohlcv.ts', () => ({ fetchClosedOHLCV: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));

import { getLatestOpenTime, upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { fetchClosedOHLCV } from './ohlcv.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { refreshOhlcv } from './refresh.ts';
import { SYMBOLS, TIMEFRAMES } from './config.ts';

function fakeClient() { return { loadMarkets: vi.fn(async () => ({})), fetchOHLCV: vi.fn() }; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLatestOpenTime).mockResolvedValue(new Date('2026-06-29T00:00:00Z'));
  vi.mocked(fetchClosedOHLCV).mockResolvedValue([{ symbol: 'BTC/USDT', timeframe: '15m', openTime: new Date(), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
  vi.mocked(upsertCandles).mockResolvedValue(1);
});

describe('refreshOhlcv', () => {
  it('llama loadMarkets una vez y refresca cada symbol×timeframe', async () => {
    const client = fakeClient();
    const r = await refreshOhlcv({ client });
    expect(client.loadMarkets).toHaveBeenCalledTimes(1);
    expect(fetchClosedOHLCV).toHaveBeenCalledTimes(SYMBOLS.length * TIMEFRAMES.length);
    expect(r.upserted).toBe(SYMBOLS.length * TIMEFRAMES.length);
  });

  it('best-effort: un símbolo que falla audita y el resto continúa', async () => {
    vi.mocked(fetchClosedOHLCV).mockRejectedValueOnce(new Error('rate limit'));
    const r = await refreshOhlcv({ client: fakeClient() });
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ohlcv_refresh_failed' }));
    expect(r.upserted).toBe(SYMBOLS.length * TIMEFRAMES.length - 1); // todos menos el que falló
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/market-data/refresh.test.ts`
Expected: FAIL ("Cannot find module './refresh.ts'").

- [ ] **Step 3: Implementa `refreshOhlcv`**

`src/lib/market-data/refresh.ts`:
```typescript
import type { Exchange } from 'ccxt';
import { SYMBOLS, TIMEFRAMES, FETCH_LIMIT, timeframeToMs, type Timeframe } from './config.ts';
import { getLatestOpenTime, upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { fetchClosedOHLCV } from './ohlcv.ts';
import { createPublicClient } from '../ccxt-client.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';

export interface RefreshOhlcvDeps {
  client: Pick<Exchange, 'loadMarkets' | 'fetchOHLCV'>;
  now: () => number;
}

// Frescura OHLCV (SP13, Componente C): mantiene kairos.ohlcv_candles al día para el scanner desatendido.
// Cliente PÚBLICO (sin API key). Best-effort por símbolo. FIX L3: loadMarkets() una vez antes del fetch.
export async function refreshOhlcv(deps: Partial<RefreshOhlcvDeps> = {}): Promise<{ upserted: number }> {
  const client = deps.client ?? createPublicClient();
  const now = deps.now ?? Date.now;
  await client.loadMarkets();
  let upserted = 0;
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      try { upserted += await refreshOne(client as Exchange, symbol, timeframe, now()); }
      catch (err) {
        try { await appendAuditLog({ eventType: 'ohlcv_refresh_failed', actor: 'ohlcv-refresh', payload: { symbol, timeframe, error: err instanceof Error ? err.message : String(err) } }); }
        catch { /* último recurso */ }
      }
    }
  }
  return { upserted };
}

async function refreshOne(client: Exchange, symbol: string, timeframe: Timeframe, now: number): Promise<number> {
  const latest = await getLatestOpenTime(symbol, timeframe);
  // since: justo después de la última vela; si no hay historia, las últimas ~2 velas (no backfill completo).
  const since = latest ? latest.getTime() + 1 : now - 2 * timeframeToMs(timeframe);
  const rows = await fetchClosedOHLCV(client, symbol, timeframe, since, FETCH_LIMIT, now);
  return rows.length > 0 ? upsertCandles(rows) : 0;
}
```

- [ ] **Step 4: Corre los tests, verifica verde**

Run: `npm test -- src/lib/market-data/refresh.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/lib/market-data/refresh.ts src/lib/market-data/refresh.test.ts
git commit -m "feat: frescura OHLCV (refreshOhlcv, cliente público, best-effort) — SP13 Componente C"
```

---

## Task 9: Constantes de cadencia + cableado del worker

**Files:**
- Modify: `src/lib/execution/limits.ts` (+ constantes)
- Create: `src/lib/execution/dispatch.ts` (helpers puros de despacho por modo, testeables)
- Create: `src/lib/execution/dispatch.test.ts`
- Modify: `src/worker.ts` (arranque reconcile por modo + ticks reconcile/refresh + monitor por modo + shutdown)

**Interfaces:**
- Produces: `RECONCILE_INTERVAL_MS`, `OHLCV_REFRESH_INTERVAL_MS` (limits.ts). `isRealMode(mode: TradingMode): boolean` (dispatch.ts).

**Contexto:** el worker no es unit-testeable fácilmente (arranca BullMQ/Redis); se valida por el smoke vivo. Lo testeable es el helper `isRealMode` y la validación de constantes. El cableado calca el patrón existente de `upsertJobScheduler`.

- [ ] **Step 1: Añade las constantes a `limits.ts`**

En `src/lib/execution/limits.ts`, añade al final:
```typescript
// Reconciler ccxt (SP13): cadencia del tick periódico de auto-sanación (arranque corre aparte).
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

// Frescura OHLCV (SP13): cadencia del refresh; debe ser ≤ MONITOR_INTERVAL_MS (el worker la valida).
export const OHLCV_REFRESH_INTERVAL_MS = 60_000;
```

- [ ] **Step 2: Escribe el test del helper de despacho (falla)**

`src/lib/execution/dispatch.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { isRealMode } from './dispatch.ts';

describe('isRealMode', () => {
  it('testnet y live son modos reales', () => {
    expect(isRealMode('testnet')).toBe(true);
    expect(isRealMode('live')).toBe(true);
  });
  it('sim no es modo real', () => {
    expect(isRealMode('sim')).toBe(false);
  });
});
```

- [ ] **Step 3: Corre, verifica que falla**

Run: `npm test -- src/lib/execution/dispatch.test.ts`
Expected: FAIL ("Cannot find module './dispatch.ts'").

- [ ] **Step 4: Implementa `isRealMode`**

`src/lib/execution/dispatch.ts`:
```typescript
import type { TradingMode } from '../mode.ts';

// Un modo es "real" si toca el exchange (testnet o live). sim usa caminos sintéticos.
// Centraliza el despacho por modo del reconciler/monitor (SP13).
export function isRealMode(mode: TradingMode): boolean {
  return mode === 'testnet' || mode === 'live';
}
```

- [ ] **Step 5: Corre el test, verifica verde**

Run: `npm test -- src/lib/execution/dispatch.test.ts`
Expected: PASS (2/2).

- [ ] **Step 6: Cablea el worker — arranque reconcile por modo**

En `src/worker.ts`, añade imports y reemplaza el bloque de arranque (líneas 26-28) para despachar por modo. Imports nuevos:
```typescript
import { getMode } from './lib/mode.ts';
import { isRealMode } from './lib/execution/dispatch.ts';
import { runExchangeReconcile } from './lib/reconcile/exchange-reconcile.ts';
import { runMonitorTickReal } from './lib/monitor/monitor-real.ts';
import { refreshOhlcv } from './lib/market-data/refresh.ts';
import { getAuthenticatedClient } from './lib/ccxt-client.ts';
import { placeOco } from './lib/execution/real-order/place-oco.ts';
import { emergencyClose } from './lib/execution/real-order/emergency-close.ts';
import type { RealClient } from './lib/execution/execute-order-real.ts';
import { RECONCILE_INTERVAL_MS, OHLCV_REFRESH_INTERVAL_MS } from './lib/execution/limits.ts';
```
Y un helper local para construir las deps reales del reconciler/monitor (credenciales en closure):
```typescript
async function realDeps() {
  const client = getAuthenticatedClient();
  await client.loadMarkets();
  const real = client as unknown as RealClient;
  return { client: real, placeOco, emergencyClose, mode: getMode() };
}
```
Reemplaza el arranque del reconcile (líneas 26-28) por:
```typescript
  const mode = getMode();
  if (isRealMode(mode)) {
    const rec = await runExchangeReconcile(await realDeps());
    process.stdout.write(`[worker] reconcile ccxt de arranque: ${rec.entries} entradas, ${rec.positions} posiciones\n`);
  } else {
    const recon = await runStartupReconcile();
    process.stdout.write(`[worker] reconcile de arranque (sim): ${recon.stuckEntries} entradas colgadas, ${recon.orphanedLegs} legs huérfanas\n`);
  }
```

- [ ] **Step 7: Cablea el worker — monitor por modo + ticks reconcile/refresh**

En `src/worker.ts`, cambia el handler del `monitorWorker` (línea 54) para despachar por modo:
```typescript
  const monitorWorker = new Worker(MONITOR_QUEUE, async () => {
    if (isRealMode(mode)) await runMonitorTickReal(new Date(), { ...(await realDeps()), notify: sendWhatsApp });
    else await runMonitorTick(new Date());
  }, { connection: conn, concurrency: 1 });
```
(añade `import { sendWhatsApp } from './notify/whatsapp.ts';` si no está.) Después del bloque del monitor (tras la línea 63), añade los dos ticks nuevos — **solo en modo real** (en sim el reconcile ccxt y un refresh continuo no aportan; el refresh sí podría correr en sim pero YAGNI para el loop testnet, así que se monta solo en real para no añadir carga):
```typescript
  let reconcileQueue: Queue | undefined, refreshQueue: Queue | undefined;
  let reconcileWorker: Worker | undefined, refreshWorker: Worker | undefined;
  if (isRealMode(mode)) {
    // FIX L-2: el spec exige refresh ≤ monitor; si no, el scanner ve velas rancias entre ticks.
    if (OHLCV_REFRESH_INTERVAL_MS > MONITOR_INTERVAL_MS) {
      process.stderr.write(`[worker] WARN: OHLCV_REFRESH_INTERVAL_MS (${OHLCV_REFRESH_INTERVAL_MS}) > MONITOR_INTERVAL_MS (${MONITOR_INTERVAL_MS})\n`);
    }
    const RECONCILE_QUEUE = 'reconcile-tick';
    reconcileWorker = new Worker(RECONCILE_QUEUE, async () => { await runExchangeReconcile(await realDeps()); }, { connection: conn, concurrency: 1 });
    reconcileWorker.on('error', (err) => process.stderr.write(`[reconcile-worker] error: ${err}\n`));
    reconcileWorker.on('failed', (job, err) => process.stderr.write(`[reconcile-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));
    reconcileQueue = new Queue(RECONCILE_QUEUE, { connection: conn });
    await reconcileQueue.upsertJobScheduler('reconcile-tick', { every: RECONCILE_INTERVAL_MS }, { name: 'tick', data: {}, opts: { removeOnComplete: true } });

    const REFRESH_QUEUE = 'ohlcv-refresh-tick';
    refreshWorker = new Worker(REFRESH_QUEUE, async () => { await refreshOhlcv(); }, { connection: conn, concurrency: 1 });
    refreshWorker.on('error', (err) => process.stderr.write(`[refresh-worker] error: ${err}\n`));
    refreshWorker.on('failed', (job, err) => process.stderr.write(`[refresh-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));
    refreshQueue = new Queue(REFRESH_QUEUE, { connection: conn });
    await refreshQueue.upsertJobScheduler('ohlcv-refresh-tick', { every: OHLCV_REFRESH_INTERVAL_MS }, { name: 'tick', data: {}, opts: { removeOnComplete: true } });
  }
```

- [ ] **Step 8: Añade los nuevos closeables al shutdown**

En el `createShutdown({ closeables: [...] })` (línea 71), añade los nuevos (con guardas, porque son opcionales). Reemplaza el array `closeables` por uno que incluya, al final, los condicionales filtrados:
```typescript
    closeables: [scanWorker, evaluateWorker, monitorWorker, scanQueue, monitorQueue,
      { close: closeEvaluateQueue }, { close: closeShadowQueue }, { close: closeSetupLockConnection },
      ...[reconcileWorker, refreshWorker, reconcileQueue, refreshQueue].filter((c): c is Worker | Queue => c !== undefined)],
```

- [ ] **Step 9: typecheck + corre la suite de la zona**

Run: `npm run typecheck && npm test -- src/lib/execution/dispatch.test.ts`
Expected: typecheck sin errores; dispatch 2/2.

- [ ] **Step 10: Commit**

```bash
git add src/lib/execution/limits.ts src/lib/execution/dispatch.ts src/lib/execution/dispatch.test.ts src/worker.ts
git commit -m "feat: cadencias SP13 + cableado worker (reconcile arranque/tick, refresh tick, monitor por modo)"
```

---

## Task 10: Suite completa + docs (CLAUDE.md, PENDIENTES.md)

**Files:**
- Modify: `CLAUDE.md` (entrada SP13 + "Dónde estamos")
- Modify: `docs/PENDIENTES.md` (mueve los ítems de testnet hechos; deja trailing/SP14)

- [ ] **Step 1: Corre la suite completa**

Run: `npm test`
Expected: toda la suite verde (incl. integración con Postgres del compose). Si algo falla, arréglalo antes de seguir.

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 3: Actualiza `CLAUDE.md`**

Añade una entrada **SP13 (hecho)** en "Progreso por sprints", con el resumen: reconciler ccxt (arranque+tick) que cierra I1, monitor de cierres reales con close-first, frescura OHLCV, gate setup-aware; clientOrderId determinista; el LLM sigue en sombra; **smoke vigilado owner-gated pendiente**. Actualiza el bloque "Dónde estamos" y los "Pendientes antes del loop testnet continuo" (ya hechos por SP13; queda el smoke + trailing + SP14).

- [ ] **Step 4: Actualiza `docs/PENDIENTES.md`**

En la sección "Diferido a testnet", marca como **hechos en SP13**: reconciler con fetch de ccxt, mantener ohlcv al día. Deja pendientes: trailing (sprint propio), `/cierra` y `/modo` (SP14), kill-switch en Redis, dedup de inbound. Añade el **smoke vigilado de SP13** a los smokes owner-gated.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/PENDIENTES.md
git commit -m "docs: SP13 hecho — reconciler/monitor ccxt + frescura OHLCV (cierra Fase 3 en código; smoke owner-gated pendiente)"
```

---

## Notas para el smoke vigilado (owner-gated, fuera de CI)

Tras mergear, con `KAIROS_MODE=testnet` y el worker vivo, verificar contra Binance testnet real:
1. **clientOrderId (H3):** una entrada coloca `newClientOrderId = signalId`; `fetchOrder(undefined, symbol, { clientOrderId })` la recupera.
2. **Reconciler:** matar el proceso tras un fill pero antes del OCO (o dejar una `protected=false`) y verificar que el reconciler de arranque re-protege o cierra con P&L real.
3. **Monitor:** dejar que un OCO llene server-side y verificar que el monitor cierra la posición en DB con P&L de fills reales y notifica.
4. **Fee (M1):** inspeccionar `order.fees[].currency` real; si aparece BNB, desactivar el descuento BNB en la cuenta de testnet.
5. **Frescura:** verificar que `ohlcv_candles` avanza su `max(open_time)` sin intervención.

---

## Self-Review (writing-plans)

**Cobertura del spec:** Componente A (reconciler) → Tasks 5+6; Componente B (monitor real) → Task 7; Componente C (frescura) → Task 8; Componente D (gate) → Task 4; cambio SP12 clientOrderId → Task 1; getFillsForOrder + finders → Task 3; constantes + worker → Task 9; FIX H1 (frescura en finder, no en gate) → Tasks 3+4; FIX H2 (close-first) → Task 7; FIX H3 (verificar ccxt) → Task 1 (verificado) + adaptador Task 2; FIX M1 (fee) → Task 1 (nota) + smoke; FIX M2 (idempotencia en posición, no fills) → Tasks 5/7; FIX M3 (handoff) → Task 7; FIX L1/L3 → Task 8. Todo cubierto.

**Consistencia de tipos:** `ReconcileDepsReal`/`MonitorRealDeps` usan `RealClient` (de execute-order-real.ts); `OrderStateClient` es subset compatible con ccxt `Exchange`. `ReconcilePosition` compartido entre positions.ts (productor) y reconciler/monitor (consumidores). `BracketLeg` de orders.ts. `entryClientOrderId` (Task 1) consumido por placeEntry; el reconciler usa `e.idempotencyKey` (= signalId = clientOrderId) directamente. Firmas de `placeOco`/`emergencyClose` calcadas de SP12.

**Sin placeholders:** cada paso de código muestra el código real; comandos con expected output.
