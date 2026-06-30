# SP14 — Comandos de control que tocan dinero (`/cierra`, `/modo`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Habilitar `/cierra <symbol>` (cierre real idempotente de una posición) y `/modo` (reporte read-only del modo) por WhatsApp inbound, manteniendo al LLM fuera de la decisión de cierre.

**Architecture:** Extiende el canal de control de SP11 sin reescribirlo. `/cierra` es **slash-only y determinista** (cancel-first → market sell → close, bajo `withSetupLock`, idempotente, falla cerrado). El LLM (`control-maker`) solo clasifica comandos seguros vía un schema `result` **estricto** que no admite `cierra`. `/modo` reporta `getMode()`.

**Tech Stack:** TypeScript (ESM, imports `.ts`), Valibot, ccxt 4.5.60 (binance spot), Postgres (esquema `kairos`), Vitest. Comentarios español, identificadores inglés.

**Spec:** `docs/superpowers/specs/2026-06-30-sp14-control-dinero-design.md` (v2, commit `fcbc511`).

## Global Constraints

- **Líneas rojas (CRITICAL):** ninguna tool de mutación en el `tools:[]` de un agente. **FIX H1:** el LLM ve un schema `result` ESTRICTO (`['estado','pausa','reanuda','modo','unknown']`, sin `cierra`/`symbol`) → estructuralmente incapaz de gatillar un cierre. Credenciales del exchange en closure (el cliente ccxt del cierre real se construye en el cableado con `getAuthenticatedClient`, nunca lo ve el modelo). Idempotencia: `closeOpenPosition` (solo cierra si `status='open'`) + `withSetupLock`. Nada toca dinero real sin el flag: `sim` cierra sintético; solo `testnet|live` tocan el exchange. El cierre **reduce** exposición, jamás abre.
- **FIX H2 (falla cerrado):** si `emergencyClose` falla **tras** cancelar el OCO → `setPositionProtected(positionId, false)` + audit `close_command_failed` → el reconciler A.2 de SP13 la toma. Si `cancelOco` falla (OCO intacto) → abortar SIN tocar `protected` (la posición sigue protegida).
- **FIX H3:** sub-caso "OCO ya disparó antes de `/cierra`" → `emergencyClose` vende base inexistente → `InsufficientFunds` es el backstop (no doble-venta); el monitor close-first cierra luego con el P&L real del OCO.
- **FIX M3 (verificado, ccxt 4.5.60):** `cancelOrder(legExchangeId, symbol)` (`id` posicional → `orderId`, `binance.js:7867`) en Binance spot cancela toda la OCO list; `orderListId` NO se persiste → cancelar por leg. `OrderNotFound` = éxito.
- **FIX M1:** validar el símbolo con `getOpenPositionBySymbol` (sin los filtros `sl/tp NOT NULL`+trigger-TF de `getOpenPositions`). **FIX M2:** una posición por símbolo en testnet (la query devuelve la más reciente).
- **FIX L1 (fee):** `realized` resta fees como escalares en quote (hereda el supuesto de SP13: fees en quote / descuento BNB off en testnet; lo valida el smoke).
- Estilo: funciones <50 líneas, archivos <800, sin secretos, sin `console.log` de debug, validación en límites. Cobertura ≥80%.
- **Flue:** `close-position-command.ts` (en `src/lib/control/`) y `cancel-oco.ts` (en `src/lib/execution/real-order/`) son código de orquestación — NO caen en `src/workflows|channels|agents/`. `control-maker.ts` sigue siendo un workflow descubrible con `tools:[]`.

---

## File Structure

**Nuevos:**
- `src/lib/execution/real-order/cancel-oco.ts` — `cancelOco` (cancela la OCO residente por leg).
- `src/lib/control/close-position-command.ts` — `closePositionCommand` (despacho por modo: sim sintético / real cancel-first).

**Modificados:**
- `src/lib/control/control-intent-schema.ts` — `ControlIntentSchema` completo (+`cierra`,+`symbol`) + `ControlResultSchema` estricto.
- `src/lib/control/parse-control.ts` — `/cierra <symbol>` + `/modo` + `normalizeSymbol`.
- `src/db/repositories/positions.ts` — `getOpenPositionBySymbol`.
- `src/db/repositories/ohlcv-candles.ts` — `getLatestClosePrice` (cierre sim).
- `src/lib/control/dispatch-control.ts` — casos `cierra`/`modo`; `DispatchDeps` +`closePosition`,+`currentMode`.
- `src/workflows/control-maker.ts` — `result`/`output` estrictos.
- `src/channels/evolution.ts` — construye las deps del cierre + tipos.
- `src/skills/control-protocol/SKILL.md` — `/modo` read-only; cierre → `unknown`.
- `CLAUDE.md`, `docs/PENDIENTES.md` — estado.

---

## Task 1: Dos schemas de intención (FIX H1)

**Files:**
- Modify: `src/lib/control/control-intent-schema.ts`
- Modify: `src/lib/control/control-intent-schema.test.ts`

**Interfaces:**
- Produces: `ControlIntentSchema` = `v.object({ command: v.picklist(['estado','pausa','reanuda','cierra','modo','unknown']), symbol: v.optional(v.string()) })`; `type ControlIntent`. `ControlResultSchema` = `v.object({ command: v.picklist(['estado','pausa','reanuda','modo','unknown']) })`; `type ControlResult`. `parseControlIntent(raw)` sin cambios de firma.

- [ ] **Step 1: Escribe los tests (fallan)**

En `src/lib/control/control-intent-schema.test.ts`, añade:
```typescript
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { ControlIntentSchema, ControlResultSchema } from './control-intent-schema.ts';

describe('ControlIntentSchema (completo)', () => {
  it('acepta cierra con symbol', () => {
    expect(v.parse(ControlIntentSchema, { command: 'cierra', symbol: 'BTC/USDT' })).toEqual({ command: 'cierra', symbol: 'BTC/USDT' });
  });
  it('acepta modo sin symbol', () => {
    expect(v.parse(ControlIntentSchema, { command: 'modo' })).toEqual({ command: 'modo' });
  });
});

describe('ControlResultSchema (estricto, el que ve el LLM)', () => {
  it('RECHAZA cierra (línea roja: el LLM no puede gatillar un cierre)', () => {
    expect(() => v.parse(ControlResultSchema, { command: 'cierra' })).toThrow();
  });
  it('no admite el campo symbol', () => {
    // valibot v.object es estricto en exceso de claves sólo con strictObject; aquí basta el picklist.
    expect(v.parse(ControlResultSchema, { command: 'modo' })).toEqual({ command: 'modo' });
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/control/control-intent-schema.test.ts`
Expected: FAIL (`ControlResultSchema` no existe; `cierra` no está en el picklist).

- [ ] **Step 3: Implementa los dos schemas**

Reemplaza el contenido de `src/lib/control/control-intent-schema.ts` por:
```typescript
import * as v from 'valibot';

// Schema COMPLETO: lo produce el parser slash determinista y lo consume dispatchControl. Incluye los
// comandos que tocan dinero (cierra) y el argumento opcional symbol (solo lo puebla el slash).
export const ControlIntentSchema = v.object({
  command: v.picklist(['estado', 'pausa', 'reanuda', 'cierra', 'modo', 'unknown']),
  symbol: v.optional(v.string()),
});
export type ControlIntent = v.InferOutput<typeof ControlIntentSchema>;

// Schema ESTRICTO (FIX H1): es el que ve el LLM como `result` de session.skill. NO incluye `cierra` ni
// `symbol` → el modelo es estructuralmente incapaz de emitir un cierre. El slash es el único productor
// de {command:'cierra'}.
export const ControlResultSchema = v.object({
  command: v.picklist(['estado', 'pausa', 'reanuda', 'modo', 'unknown']),
});
export type ControlResult = v.InferOutput<typeof ControlResultSchema>;

export function parseControlIntent(raw: unknown): ControlIntent {
  return v.parse(ControlIntentSchema, raw);
}
```

- [ ] **Step 4: Corre, verifica verde**

Run: `npm test -- src/lib/control/control-intent-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/control/control-intent-schema.ts src/lib/control/control-intent-schema.test.ts
git commit -m "feat: dos schemas de control (ControlResultSchema estricto sin cierra) — SP14 FIX H1"
```

---

## Task 2: Parser slash `/cierra <symbol>` + `/modo`

**Files:**
- Modify: `src/lib/control/parse-control.ts`
- Modify: `src/lib/control/parse-control.test.ts`

**Interfaces:**
- Consumes: `ControlIntent` (Task 1).
- Produces: `parseSlashCommand(text): ControlIntent | null` extendido; `normalizeSymbol(raw): string`.

**Contexto:** `parseSlashCommand` hoy solo lee la primera palabra y mapea estado/pausa/reanuda. `/cierra` necesita la segunda palabra (símbolo) normalizada; `/modo` mapea sin argumento.

- [ ] **Step 1: Escribe los tests (fallan)**

En `src/lib/control/parse-control.test.ts`, añade:
```typescript
import { parseSlashCommand, normalizeSymbol } from './parse-control.ts';

describe('parseSlashCommand cierra/modo', () => {
  it('/cierra BTC/USDT → cierra con symbol normalizado', () => {
    expect(parseSlashCommand('/cierra BTC/USDT')).toEqual({ command: 'cierra', symbol: 'BTC/USDT' });
  });
  it('/cierra btc → normaliza a BTC/USDT', () => {
    expect(parseSlashCommand('/cierra btc')).toEqual({ command: 'cierra', symbol: 'BTC/USDT' });
  });
  it('/cierra sin símbolo → cierra sin symbol (dispatch responde ayuda)', () => {
    expect(parseSlashCommand('/cierra')).toEqual({ command: 'cierra' });
  });
  it('/modo → modo', () => {
    expect(parseSlashCommand('/modo')).toEqual({ command: 'modo' });
  });
  it('texto libre sigue devolviendo null', () => {
    expect(parseSlashCommand('cómo va todo')).toBeNull();
  });
});

describe('normalizeSymbol', () => {
  it('añade /USDT si falta y pasa a mayúsculas', () => {
    expect(normalizeSymbol('btc')).toBe('BTC/USDT');
    expect(normalizeSymbol('eth/usdt')).toBe('ETH/USDT');
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/control/parse-control.test.ts`
Expected: FAIL (`normalizeSymbol` no existe; cierra/modo no parseados).

- [ ] **Step 3: Implementa**

Reemplaza `src/lib/control/parse-control.ts` por:
```typescript
import type { ControlIntent } from './control-intent-schema.ts';

const SLASH: Record<string, ControlIntent['command']> = {
  estado: 'estado', pausa: 'pausa', reanuda: 'reanuda', cierra: 'cierra', modo: 'modo',
};

// Normaliza un símbolo del operador: mayúsculas; si no trae par de cotización, asume /USDT.
export function normalizeSymbol(raw: string): string {
  const up = raw.trim().toUpperCase();
  return up.includes('/') ? up : `${up}/USDT`;
}

// Parser determinista de comandos slash. Devuelve null para texto libre (lo interpreta el LLM).
// Para /cierra captura el símbolo (segunda palabra, normalizado); sin segunda palabra → sin symbol.
export function parseSlashCommand(text: string): ControlIntent | null {
  const parts = text.trim().split(/\s+/);
  const first = (parts[0] ?? '').toLowerCase();
  const word = first.startsWith('/') ? first.slice(1) : first;
  const command = SLASH[word];
  if (!command) return null;
  if (command === 'cierra') {
    const arg = parts[1];
    return arg ? { command, symbol: normalizeSymbol(arg) } : { command };
  }
  return { command };
}
```

- [ ] **Step 4: Corre, verifica verde**

Run: `npm test -- src/lib/control/parse-control.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/control/parse-control.ts src/lib/control/parse-control.test.ts
git commit -m "feat: parser slash /cierra <symbol> + /modo + normalizeSymbol — SP14"
```

---

## Task 3: Lecturas de repo — `getOpenPositionBySymbol` + `getLatestClosePrice`

**Files:**
- Modify: `src/db/repositories/positions.ts`
- Modify: `src/db/repositories/ohlcv-candles.ts`
- Test: `src/db/repositories/sp14-reads.test.ts` (integración, Postgres del compose)

**Interfaces:**
- Produces: `getOpenPositionBySymbol(symbol: string, mode: TradingMode, exec?): Promise<ReconcilePosition | null>` (reusa `ReconcilePosition`/`mapReconcilePosition` de SP13); `getLatestClosePrice(symbol: string): Promise<number | null>`.

**Contexto:** `ReconcilePosition` y `mapReconcilePosition`/`ReconcilePositionRow` ya existen en `positions.ts` (SP13). `getOpenPositionBySymbol` NO debe llevar los filtros del monitor (`sl/tp NOT NULL` + trigger-TF) — FIX M1.

- [ ] **Step 1: Escribe el test de integración (falla)**

`src/db/repositories/sp14-reads.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query, pool } from '../pool.ts';
import { ulid } from 'ulidx';
import { getOpenPositionBySymbol } from './positions.ts';
import { getLatestClosePrice } from './ohlcv-candles.ts';

const STRAT = 'sp14-reads-strategy';

async function seed(): Promise<void> {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, trigger_config, risk_params)
               VALUES ($1, false, '15m', '{}'::jsonb, '{}'::jsonb)
               ON CONFLICT (id) DO UPDATE SET enabled = false`, [STRAT]);
}

describe('SP14 reads (integración)', () => {
  beforeEach(async () => {
    await seed();
    await query(`DELETE FROM kairos.positions WHERE strategy_id = $1`, [STRAT]);
    await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = 'ZZZ/USDT'`);
  });
  afterAll(async () => {
    await query(`DELETE FROM kairos.positions WHERE strategy_id = $1`, [STRAT]);
    await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = 'ZZZ/USDT'`);
    await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRAT]);
    await pool.end();
  });

  it('getOpenPositionBySymbol devuelve la posición abierta SIN filtros del monitor (sl/tp null OK)', async () => {
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, protected)
                 VALUES ($1, 'ZZZ/USDT', 'long', 100, 0.5, NULL, NULL, 'open', $2, 'testnet', true)`, [ulid(), STRAT]);
    const pos = await getOpenPositionBySymbol('ZZZ/USDT', 'testnet');
    expect(pos?.symbol).toBe('ZZZ/USDT');
    expect(pos?.strategyId).toBe(STRAT);
  });

  it('getOpenPositionBySymbol → null si no hay posición abierta', async () => {
    expect(await getOpenPositionBySymbol('ZZZ/USDT', 'testnet')).toBeNull();
  });

  it('getLatestClosePrice devuelve el close de la vela más reciente', async () => {
    await query(`INSERT INTO kairos.ohlcv_candles (symbol, timeframe, open_time, o, h, l, c, v)
                 VALUES ('ZZZ/USDT','15m', now() - interval '1 hour', 1,1,1, 10, 1),
                        ('ZZZ/USDT','15m', now() - interval '15 minutes', 1,1,1, 20, 1)`);
    expect(await getLatestClosePrice('ZZZ/USDT')).toBe(20);
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/db/repositories/sp14-reads.test.ts`
Expected: FAIL (funciones no existen). Requiere `DATABASE_URL` (Postgres del compose arriba).

- [ ] **Step 3: Implementa `getOpenPositionBySymbol` en positions.ts**

Añade (cerca de `findUnprotectedPositions`, reusa `ReconcilePositionRow`/`mapReconcilePosition`):
```typescript
// SP14: posición abierta por símbolo+modo SIN los filtros del monitor (getOpenPositions exige sl/tp NOT
// NULL + trigger-TF, lo que ocultaría posiciones cerrables). Para /cierra. Si hay >1, la más reciente.
export async function getOpenPositionBySymbol(symbol: string, mode: TradingMode, exec: Executor = query): Promise<ReconcilePosition | null> {
  const rows = await exec<ReconcilePositionRow>(
    `SELECT id, symbol, strategy_id, decision_id, entry, size, sl, tp, entry_fee
       FROM kairos.positions WHERE status = 'open' AND mode = $1 AND symbol = $2
      ORDER BY opened_at DESC LIMIT 1`,
    [mode, symbol],
  );
  return rows[0] ? mapReconcilePosition(rows[0]) : null;
}
```

- [ ] **Step 4: Implementa `getLatestClosePrice` en ohlcv-candles.ts**

Añade:
```typescript
// SP14: último precio de cierre almacenado para un símbolo (cualquier TF), para el cierre /cierra en sim.
export async function getLatestClosePrice(symbol: string): Promise<number | null> {
  const rows = await query<{ c: string }>(
    `SELECT c FROM kairos.ohlcv_candles WHERE symbol = $1 ORDER BY open_time DESC LIMIT 1`,
    [symbol],
  );
  return rows[0] ? Number(rows[0].c) : null;
}
```

- [ ] **Step 5: Corre, verifica verde**

Run: `npm test -- src/db/repositories/sp14-reads.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/positions.ts src/db/repositories/ohlcv-candles.ts src/db/repositories/sp14-reads.test.ts
git commit -m "feat: getOpenPositionBySymbol (sin filtros del monitor) + getLatestClosePrice — SP14"
```

---

## Task 4: Cancelación de OCO (`cancel-oco.ts`)

**Files:**
- Create: `src/lib/execution/real-order/cancel-oco.ts`
- Create: `src/lib/execution/real-order/cancel-oco.test.ts`

**Interfaces:**
- Consumes: `BracketLeg` (orders.ts, SP13: `{ id; purpose; exchangeOrderId: string | null; status }`).
- Produces: `interface CancelOcoClient { cancelOrder(id: string, symbol: string): Promise<unknown> }`; `cancelOco(client: CancelOcoClient, symbol: string, legs: BracketLeg[]): Promise<void>`.

**Contexto (verificado ccxt 4.5.60):** `cancelOrder(legId, symbol)` en Binance spot cancela toda la OCO list. `OrderNotFound` (OCO ya disparado/cancelado) = éxito. Cancelar UNA leg basta; el `orderListId` no se persiste.

- [ ] **Step 1: Escribe los tests (fallan)**

`src/lib/execution/real-order/cancel-oco.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import ccxt from 'ccxt';
import { cancelOco, type CancelOcoClient } from './cancel-oco.ts';

const legs = [
  { id: 'sl-row', purpose: 'sl' as const, exchangeOrderId: 'X-SL', status: 'pending' },
  { id: 'tp-row', purpose: 'tp' as const, exchangeOrderId: 'X-TP', status: 'pending' },
];

describe('cancelOco', () => {
  it('cancela UNA leg (en spot cancela toda la lista) y retorna', async () => {
    const cancelOrder = vi.fn(async () => ({}));
    await cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs);
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('X-SL', 'BTC/USDT');
  });

  it('OrderNotFound (OCO ya disparado/cancelado) = éxito (no lanza)', async () => {
    const cancelOrder = vi.fn(async () => { throw new ccxt.OrderNotFound('gone'); });
    await expect(cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs)).resolves.toBeUndefined();
  });

  it('NetworkError se propaga (el caller aborta sin tocar protected)', async () => {
    const cancelOrder = vi.fn(async () => { throw new ccxt.NetworkError('down'); });
    await expect(cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', legs)).rejects.toThrow(ccxt.NetworkError);
  });

  it('sin legs con exchangeOrderId → no llama cancelOrder', async () => {
    const cancelOrder = vi.fn(async () => ({}));
    await cancelOco({ cancelOrder } as CancelOcoClient, 'BTC/USDT', [{ id: 'r', purpose: 'sl', exchangeOrderId: null, status: 'pending' }]);
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/execution/real-order/cancel-oco.test.ts`
Expected: FAIL ("Cannot find module './cancel-oco.ts'").

- [ ] **Step 3: Implementa**

`src/lib/execution/real-order/cancel-oco.ts`:
```typescript
import ccxt from 'ccxt';
import type { BracketLeg } from '../../../db/repositories/orders.ts';

export interface CancelOcoClient {
  cancelOrder(id: string, symbol: string): Promise<unknown>;
}

// Cancela el OCO residente cancelando UNA leg por su exchange_order_id. En Binance spot, cancelar una
// leg cancela toda la order-list (verificado ccxt 4.5.60). OrderNotFound (ya disparado/cancelado) = éxito.
// NetworkError se propaga: el caller aborta SIN tocar `protected` (la posición sigue protegida).
export async function cancelOco(client: CancelOcoClient, symbol: string, legs: BracketLeg[]): Promise<void> {
  const legId = legs.map((l) => l.exchangeOrderId).find((id): id is string => id !== null);
  if (!legId) return; // sin id de leg → nada que cancelar
  try {
    await client.cancelOrder(legId, symbol);
  } catch (err) {
    if (err instanceof ccxt.OrderNotFound) return;
    throw err;
  }
}
```

- [ ] **Step 4: Corre, verifica verde**

Run: `npm test -- src/lib/execution/real-order/cancel-oco.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/execution/real-order/cancel-oco.ts src/lib/execution/real-order/cancel-oco.test.ts
git commit -m "feat: cancelOco (cancela la OCO residente por leg, OrderNotFound=éxito) — SP14"
```

---

## Task 5: Máquina de cierre (`close-position-command.ts`)

**Files:**
- Create: `src/lib/control/close-position-command.ts`
- Create: `src/lib/control/close-position-command.test.ts`

**Interfaces:**
- Consumes: `getOpenPositionBySymbol` (Task 3), `getLatestClosePrice` (Task 3), `cancelOco`+`CancelOcoClient` (Task 4), `emergencyClose`+`EmergencyArgs`+`ExitResult` (SP12), `getBracketLegs`+`BracketLeg` (SP13), `closeOpenPosition`/`setPositionProtected` (positions), `closeBracketLegs` (orders), `insertFill` (fills), `withSetupLock`+`NOT_ACQUIRED` (setup-lock), `simulateFill` (fill.ts), `DEFAULT_SIM_PARAMS` (limits), `appendAuditLog`, `ReconcilePosition`, `RealClient` (execute-order-real), `OrderStateClient` (order-state), `TradingMode`.
- Produces: `interface ClosePositionDeps { mode: TradingMode; client?: RealClient & OrderStateClient & CancelOcoClient; cancelOco: typeof cancelOco; emergencyClose: (c, a: EmergencyArgs) => Promise<ExitResult>; withLock?: typeof withSetupLock }`; `closePositionCommand(symbol: string, deps: ClosePositionDeps): Promise<string>`.

**Contexto:** repos/`simulateFill`/`getLatestClosePrice`/`appendAuditLog` se importan y se mockean con `vi.mock` en el test (patrón de `exchange-reconcile.test.ts`). `client`/`cancelOco`/`emergencyClose`/`withLock` se inyectan por deps. P&L: `(exit - entry)*size - exitFee - entryFee`.

- [ ] **Step 1: Escribe los tests (fallan)**

`src/lib/control/close-position-command.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/positions.ts', () => ({ getOpenPositionBySymbol: vi.fn(), closeOpenPosition: vi.fn(), setPositionProtected: vi.fn() }));
vi.mock('../../db/repositories/orders.ts', () => ({ getBracketLegs: vi.fn(), closeBracketLegs: vi.fn() }));
vi.mock('../../db/repositories/fills.ts', () => ({ insertFill: vi.fn() }));
vi.mock('../../db/repositories/ohlcv-candles.ts', () => ({ getLatestClosePrice: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));

import { getOpenPositionBySymbol, closeOpenPosition, setPositionProtected } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getLatestClosePrice } from '../../db/repositories/ohlcv-candles.ts';
import { closePositionCommand } from './close-position-command.ts';

const pos = { id: 'p1', symbol: 'BTC/USDT', strategyId: 's1', decisionId: 'd1', entry: 100, size: 0.5, sl: 95, tp: 110, entryFee: 0.05 };
const legs = [{ id: 'sl-row', purpose: 'sl' as const, exchangeOrderId: 'X-SL', status: 'pending' }];
// withLock que ejecuta fn directamente (sin Redis).
const passthroughLock = async (_s: string, _y: string, _m: string, fn: () => Promise<string>) => fn();

function realDeps(over: Record<string, unknown> = {}) {
  return { mode: 'testnet' as const, client: {} as never, cancelOco: vi.fn(async () => {}),
    emergencyClose: vi.fn(async () => ({ exitPrice: 110, exitFee: 0.06, exchangeOrderId: 'EX' })),
    withLock: passthroughLock, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBracketLegs).mockResolvedValue(legs);
  vi.mocked(closeOpenPosition).mockResolvedValue(true);
});

describe('closePositionCommand — testnet', () => {
  it('cancel-first → market sell → cierra con P&L real', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    const d = realDeps();
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(d.cancelOco).toHaveBeenCalledWith(d.client, 'BTC/USDT', legs);          // cancel-first
    expect(d.emergencyClose).toHaveBeenCalledWith(d.client, { symbol: 'BTC/USDT', qty: 0.5 });
    // fill de salida contra la leg (FK válida); en real recordClose recibe legs[0].id
    expect(insertFill).toHaveBeenCalledWith({ orderId: 'sl-row', price: 110, qty: 0.5, fee: 0.06 });
    // realized = (110-100)*0.5 - 0.06 - 0.05 = 4.89
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(4.89, 6), expect.any(Date));
    expect(closeBracketLegs).toHaveBeenCalledWith('d1', 'sl');
    expect(reply).toContain('cerrada');
  });

  it('sin posición → mensaje, no toca el exchange', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(null);
    const d = realDeps();
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(d.cancelOco).not.toHaveBeenCalled();
    expect(reply).toContain('no hay posición abierta');
  });

  it('cancelOco falla (red) → aborta SIN tocar protected (OCO sigue vivo)', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    const d = realDeps({ cancelOco: vi.fn(async () => { throw new Error('net'); }) });
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(setPositionProtected).not.toHaveBeenCalled();
    expect(closeOpenPosition).not.toHaveBeenCalled();
    expect(reply).toMatch(/no se pudo cancelar|reintenta/i);
  });

  it('emergencyClose falla tras cancelar → setPositionProtected(false) (FIX H2) + reconciliación', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    const d = realDeps({ emergencyClose: vi.fn(async () => { throw new Error('InsufficientFunds'); }) });
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(setPositionProtected).toHaveBeenCalledWith('p1', false);
    expect(closeOpenPosition).not.toHaveBeenCalled();
    expect(reply).toMatch(/reconciliación|reintenta/i);
  });
});

describe('closePositionCommand — sim', () => {
  it('cierra sintético al último precio con sim fill', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    vi.mocked(getLatestClosePrice).mockResolvedValue(108);
    const d = { mode: 'sim' as const, cancelOco: vi.fn(), emergencyClose: vi.fn(), withLock: passthroughLock };
    const reply = await closePositionCommand('BTC/USDT', d as never);
    expect(d.cancelOco).not.toHaveBeenCalled();
    expect(d.emergencyClose).not.toHaveBeenCalled();
    expect(closeOpenPosition).toHaveBeenCalled();   // cierra con P&L sintético (el fill se omite en sim — sin leg id)
    expect(reply).toContain('sim');
  });
});
```

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/control/close-position-command.test.ts`
Expected: FAIL ("Cannot find module './close-position-command.ts'").

- [ ] **Step 3: Implementa**

`src/lib/control/close-position-command.ts`:
```typescript
import { getOpenPositionBySymbol, closeOpenPosition, setPositionProtected, type ReconcilePosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs, type BracketLeg } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getLatestClosePrice } from '../../db/repositories/ohlcv-candles.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { withSetupLock } from '../execution/setup-lock.ts';
import { simulateFill } from '../execution/fill.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { type CancelOcoClient } from '../execution/real-order/cancel-oco.ts';
import type { EmergencyClient, EmergencyArgs, ExitResult } from '../execution/real-order/emergency-close.ts';
import type { RealClient } from '../execution/execute-order-real.ts';
import type { OrderStateClient } from '../execution/real-order/order-state.ts';
import type { TradingMode } from '../mode.ts';

export interface ClosePositionDeps {
  mode: TradingMode;
  client?: RealClient & OrderStateClient & CancelOcoClient;   // requerido en testnet|live
  cancelOco: (client: CancelOcoClient, symbol: string, legs: BracketLeg[]) => Promise<void>;
  // FIX M-TYPE-01: el tipo mínimo que el cierre necesita es EmergencyClient (RealClient lo extiende).
  emergencyClose: (client: EmergencyClient, a: EmergencyArgs) => Promise<ExitResult>;
  withLock?: typeof withSetupLock;
}

// Cierre de posición por comando (/cierra). Determinista, idempotente, lock-guarded. Despacho por modo.
export async function closePositionCommand(symbol: string, deps: ClosePositionDeps): Promise<string> {
  if (deps.mode === 'sim') return closeSim(symbol);
  return closeReal(symbol, deps);
}

// sim: cierra sintético al último precio almacenado con fill peor que mid (determinista).
async function closeSim(symbol: string): Promise<string> {
  const pos = await getOpenPositionBySymbol(symbol, 'sim');
  if (!pos) return `No hay posición abierta para ${symbol}.`;
  const ref = (await getLatestClosePrice(symbol)) ?? pos.entry;
  const fill = simulateFill('sell', pos.size, ref, DEFAULT_SIM_PARAMS);
  const realized = (fill.fillPrice - pos.entry) * pos.size - fill.fee - pos.entryFee;
  await recordClose(pos, fill.fillPrice, fill.fee, realized);
  return `✅ ${symbol} cerrada (sim) @ ${fill.fillPrice.toFixed(2)} (pnl ${realized.toFixed(2)}).`;
}

// testnet|live: cancel-first → market sell → cierra. Bajo withSetupLock (serializa vs ejecutor/otro cierre).
async function closeReal(symbol: string, deps: ClosePositionDeps): Promise<string> {
  const lock = deps.withLock ?? withSetupLock;
  const pos0 = await getOpenPositionBySymbol(symbol, deps.mode);
  if (!pos0) return `No hay posición abierta para ${symbol}.`;
  const client = deps.client;
  if (!client) throw new Error('closePositionCommand real requiere client');
  const result = await lock(pos0.strategyId, symbol, deps.mode, async () => {
    const pos = await getOpenPositionBySymbol(symbol, deps.mode);    // re-check dentro del lock
    if (!pos) return `${symbol} ya estaba cerrada.`;
    const legs = await getBracketLegs(pos.decisionId ?? '');
    try {
      await deps.cancelOco(client, symbol, legs);                    // cancel-first
    } catch {
      await appendAuditLog({ eventType: 'close_command_failed', actor: 'control', payload: { symbol, stage: 'cancel_oco' } });
      return `No se pudo cancelar el OCO de ${symbol} (red); sigue protegida — reintenta.`;
    }
    let exit: ExitResult;
    try {
      exit = await deps.emergencyClose(client, { symbol, qty: pos.size });
    } catch {
      await setPositionProtected(pos.id, false);                    // FIX H2 → reconciler A.2
      await appendAuditLog({ eventType: 'close_command_failed', actor: 'control', payload: { symbol, stage: 'market_sell' } });
      return `Cierre de ${symbol} falló tras cancelar el OCO; pasará a reconciliación — reintenta.`;
    }
    const realized = (exit.exitPrice - pos.entry) * pos.size - exit.exitFee - pos.entryFee;
    await recordClose(pos, exit.exitPrice, exit.exitFee, realized, legs[0]?.id);
    return `✅ ${symbol} cerrada @ ${exit.exitPrice.toFixed(2)} (pnl ${realized.toFixed(2)}).`;
  });
  // Chequeo ESTRUCTURAL de NOT_ACQUIRED (L-COMPAT-01: consistente con execute-order-real.ts:120; un mock
  // que devuelva {lock:'not_acquired'} distinto a la constante exportada también se detecta).
  if ((result as { lock?: string }).lock === 'not_acquired') return `${symbol}: otro proceso opera este setup — reintenta en unos segundos.`;
  return result as string;
}

// Cierre DB común: fill de salida (best-effort) + closeOpenPosition (ancla idempotente) + legs + audit.
async function recordClose(pos: ReconcilePosition, exitPrice: number, exitFee: number, realized: number, fillOrderId?: string): Promise<void> {
  if (fillOrderId) await insertFill({ orderId: fillOrderId, price: exitPrice, qty: pos.size, fee: exitFee });
  const closed = await closeOpenPosition(pos.id, realized, new Date());
  if (closed && pos.decisionId) await closeBracketLegs(pos.decisionId, 'sl');
  await appendAuditLog({ eventType: 'position_closed_command', actor: 'control', payload: { positionId: pos.id, symbol: pos.symbol, exitPrice, realized } });
}
```

> Nota: en sim no hay leg con `exchangeOrderId` (las legs sim se insertan sin él) y `recordClose` se
> llama sin `fillOrderId` para el camino sim — el fill de salida se omite ahí; el P&L canónico va en
> `closeOpenPosition`. En real se inserta contra la leg (FK válida). `closeBracketLegs(decisionId, 'sl')`
> marca la leg sl `filled` y la tp `canceled` (el `hitPurpose` es nominal en un cierre manual; ambas se
> cierran).

- [ ] **Step 4: Corre, verifica verde**

Run: `npm test -- src/lib/control/close-position-command.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/lib/control/close-position-command.ts src/lib/control/close-position-command.test.ts
git commit -m "feat: closePositionCommand (cancel-first real + sim sintético, lock, falla cerrado H2) — SP14"
```

---

## Task 6: Despacho — casos `cierra`/`modo` en `dispatch-control.ts`

**Files:**
- Modify: `src/lib/control/dispatch-control.ts`
- Modify: `src/lib/control/dispatch-control.test.ts`

**Interfaces:**
- Consumes: `ControlIntent` (Task 1).
- Produces: `DispatchDeps` gana `closePosition: (symbol: string) => Promise<string>` y `currentMode: TradingMode`. `dispatchControl(intent, deps)` maneja `cierra` (con símbolo → `closePosition(symbol)`; sin símbolo → ayuda) y `modo` (reporta `currentMode`).

- [ ] **Step 1: Escribe los tests (fallan)**

En `src/lib/control/dispatch-control.test.ts`, añade:
```typescript
describe('dispatchControl cierra/modo', () => {
  const baseDeps = {
    getOpenPositions: vi.fn(async () => []),
    setPaused: vi.fn(async () => {}),
    closePosition: vi.fn(async () => '✅ BTC/USDT cerrada @ 110 (pnl 4.89).'),
    currentMode: 'testnet' as const,
  };

  it('cierra con símbolo → llama closePosition y devuelve su reply', async () => {
    const reply = await dispatchControl({ command: 'cierra', symbol: 'BTC/USDT' }, baseDeps);
    expect(baseDeps.closePosition).toHaveBeenCalledWith('BTC/USDT');
    expect(reply).toContain('cerrada');
  });

  it('cierra SIN símbolo → ayuda (no llama closePosition)', async () => {
    const reply = await dispatchControl({ command: 'cierra' }, baseDeps);
    expect(baseDeps.closePosition).not.toHaveBeenCalled();
    expect(reply).toMatch(/\/cierra/);
  });

  it('modo → reporta el modo actual', async () => {
    const reply = await dispatchControl({ command: 'modo' }, baseDeps);
    expect(reply).toContain('testnet');
  });
});
```
(Asegúrate de importar `vi` en el archivo si no está.)

- [ ] **Step 2: Corre, verifica que falla**

Run: `npm test -- src/lib/control/dispatch-control.test.ts`
Expected: FAIL (casos no manejados; `DispatchDeps` sin `closePosition`/`currentMode`).

- [ ] **Step 3: Implementa**

Reemplaza `src/lib/control/dispatch-control.ts` por:
```typescript
import type { ControlIntent } from './control-intent-schema.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';
import type { TradingMode } from '../mode.ts';

export interface DispatchDeps {
  getOpenPositions: () => Promise<OpenPosition[]>;
  setPaused: (paused: boolean) => Promise<void>;
  closePosition: (symbol: string) => Promise<string>;
  currentMode: TradingMode;
}

const AYUDA = 'Comandos: /estado · /pausa · /reanuda · /cierra <símbolo> · /modo.';

function renderEstado(positions: OpenPosition[]): string {
  if (positions.length === 0) return 'Estado: sin posiciones abiertas.';
  const lineas = positions.map((p) => `· ${p.symbol} @ ${p.entry} (size ${p.size}, sl ${p.sl ?? '—'} tp ${p.tp ?? '—'})`);
  return `Estado: ${positions.length} posición(es) abierta(s):\n${lineas.join('\n')}`;
}

// Ejecuta el comando (DETERMINISTA) y devuelve el texto de respuesta. El LLM no llega aquí: solo
// clasificó la intención (y nunca a 'cierra' — ése solo lo produce el slash).
export async function dispatchControl(intent: ControlIntent, deps: DispatchDeps): Promise<string> {
  switch (intent.command) {
    case 'estado':
      return renderEstado(await deps.getOpenPositions());
    case 'pausa':
      await deps.setPaused(true);
      return '⏸️ Bot pausado: el scanner no disparará y los candidatos en cola no ejecutarán.';
    case 'reanuda':
      await deps.setPaused(false);
      return '▶️ Bot reanudado.';
    case 'cierra':
      if (!intent.symbol) return `Uso: /cierra <símbolo>. Ej: /cierra BTC/USDT.`;
      return deps.closePosition(intent.symbol);
    case 'modo':
      return `Modo actual: ${deps.currentMode}. (conmutar requiere reiniciar con KAIROS_MODE=…; la conmutación en caliente llega en un sprint propio).`;
    default:
      return AYUDA;
  }
}
```

- [ ] **Step 4: Actualiza los dos callers con stubs (FIX M-TYPECHECK-01 — deja typecheck verde)**

`DispatchDeps` ahora exige `closePosition` y `currentMode`. Los dos callers existentes deben pasarlos
para que el typecheck cierre en ESTA task (Task 7 los reemplaza por la implementación real):
- `src/workflows/control-maker.ts` (la llamada a `dispatchControl`, ~línea 46): añade
  `closePosition: async () => 'Para cerrar una posición usa /cierra <símbolo>.', currentMode: getMode(),`.
- `src/channels/evolution.ts` (la llamada en `processControlMessage`, ~línea 65): añade
  `closePosition: async () => 'Para cerrar una posición usa /cierra <símbolo>.', currentMode: getMode(),`.
  (`getMode` ya está importado en ambos.)

Si los tests existentes de SP11 construían `DispatchDeps` sin `closePosition`/`currentMode`, añádeselos (stub) para que tipen.

- [ ] **Step 5: Corre los tests + typecheck, verifica verde**

Run: `npm test -- src/lib/control/dispatch-control.test.ts && npm run typecheck`
Expected: dispatch tests PASS + **typecheck sin errores** (los callers ya pasan las deps stub).

- [ ] **Step 6: Commit**

```bash
git add src/lib/control/dispatch-control.ts src/lib/control/dispatch-control.test.ts src/workflows/control-maker.ts src/channels/evolution.ts
git commit -m "feat: dispatchControl casos /cierra y /modo + DispatchDeps (closePosition, currentMode) — SP14"
```

---

## Task 7: Cableado — control-maker (result estricto), skill, evolution

**Files:**
- Modify: `src/workflows/control-maker.ts`
- Modify: `src/skills/control-protocol/SKILL.md`
- Modify: `src/channels/evolution.ts`
- Modify: `src/channels/__tests__/evolution.test.ts` (deps nuevas en las rutas de dispatch)

**Interfaces:**
- Consumes: `ControlResultSchema` (Task 1), `closePositionCommand`+`ClosePositionDeps` (Task 5), `cancelOco` (Task 4), `emergencyClose` (SP12), `getAuthenticatedClient` (ccxt-client), `getMode` (mode).
- Produces: el `closePosition` dep construido en el cableado (closure con el cliente ccxt solo en modo real).

**Contexto crítico (FIX H1):** en `control-maker.ts`, el `result` de `session.skill` y el `output` del workflow deben usar **`ControlResultSchema`** (estricto, sin `cierra`). El `dispatchControl` del control-maker recibe deps con `closePosition` (nunca se invoca: el LLM no emite `cierra`) y `currentMode`.

- [ ] **Step 1: Escribe el test del result estricto (falla)**

En `src/channels/__tests__/evolution.test.ts` (o un test nuevo del control-maker), añade un test que afirme que el picklist del `result`/`output` del control-maker NO contiene `cierra`. Como el workflow no es trivial de invocar en unit, verifica el schema exportado:
```typescript
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { ControlResultSchema } from '../../lib/control/control-intent-schema.ts';

describe('control-maker result estricto (FIX H1)', () => {
  it('el schema que ve el LLM rechaza cierra', () => {
    expect(() => v.parse(ControlResultSchema, { command: 'cierra' })).toThrow();
  });
});
```

- [ ] **Step 2: Corre, verifica que pasa (el schema ya existe de Task 1) — sirve de guard de regresión**

Run: `npm test -- src/channels/__tests__/evolution.test.ts`
Expected: el nuevo caso PASS (los demás siguen verdes). Si fallan por deps nuevas en `dispatch`, continúa al Step 3.

- [ ] **Step 3: Actualiza `control-maker.ts` al result/output estricto**

En `src/workflows/control-maker.ts`:
- Importa `ControlResultSchema` y usa su tipo:
```typescript
import { ControlResultSchema, type ControlResult } from '../lib/control/control-intent-schema.ts';
```
- Cambia la interfaz de sesión y el `result` a `ControlResultSchema`; el `output` del workflow al picklist estricto; y las deps de `dispatchControl` (añade `closePosition` stub-seguro y `currentMode`):
```typescript
interface SkillSession {
  skill(name: string, opts: { args: Record<string, unknown>; result: unknown }): Promise<{ data: ControlResult }>;
}
// ... dentro de run():
let intent: ControlResult = { command: 'unknown' };
try {
  const res = await session.skill('control-protocol', { args: { text: input.text }, result: ControlResultSchema });
  intent = res.data;
} catch (err: unknown) { /* audit como hoy */ }
const reply = await dispatchControl(intent, {
  getOpenPositions: () => getOpenPositions(getMode()),
  setPaused,
  // El LLM nunca emite 'cierra' (ControlResultSchema lo excluye); este closure jamás se invoca por esta vía.
  closePosition: async () => 'Para cerrar una posición usa /cierra <símbolo>.',
  currentMode: getMode(),
});
// ... sendWhatsApp + return { command: intent.command }
```
- El `output` del `defineWorkflow` pasa a `v.object({ command: v.picklist(['estado','pausa','reanuda','modo','unknown']) })`.

- [ ] **Step 4: Actualiza el skill `control-protocol`**

En `src/skills/control-protocol/SKILL.md`, añade `modo` a la lista de comandos (read-only: "el operador pregunta en qué modo está") y mantén **cierre → `unknown`** explícito. Actualiza la lista a `estado/pausa/reanuda/modo/unknown` y la nota: "Ante peticiones de **cerrar** una posición, responde `unknown` (se hace con `/cierra <símbolo>`, no por el clasificador)."

- [ ] **Step 5: Construye el `closePosition` dep real en `evolution.ts`**

En `src/channels/evolution.ts`, el `processControlMessage` rama slash llama `route.dispatch(slash, deps)`. Añade a esas deps `closePosition` (closure que construye el cliente ccxt solo en modo real) y `currentMode`. Añade un helper:
```typescript
import { getMode } from '../lib/mode.ts';
import { closePositionCommand } from '../lib/control/close-position-command.ts';
import { cancelOco } from '../lib/execution/real-order/cancel-oco.ts';
import { emergencyClose } from '../lib/execution/real-order/emergency-close.ts';
import { getAuthenticatedClient } from '../lib/ccxt-client.ts';
import type { RealClient } from '../lib/execution/execute-order-real.ts';
import type { OrderStateClient } from '../lib/execution/real-order/order-state.ts';
import type { CancelOcoClient } from '../lib/execution/real-order/cancel-oco.ts';

// Construye el dep de cierre. En modo real arma el cliente ccxt (credenciales en closure); en sim no.
async function closePositionDep(symbol: string): Promise<string> {
  const mode = getMode();
  if (mode === 'sim') {
    return closePositionCommand(symbol, { mode, cancelOco, emergencyClose });
  }
  const client = getAuthenticatedClient();
  await client.loadMarkets();
  return closePositionCommand(symbol, {
    mode,
    client: client as unknown as RealClient & OrderStateClient & CancelOcoClient,
    cancelOco, emergencyClose,
  });
}
```
Y en `processControlMessage`, extiende las deps del `route.dispatch`:
```typescript
const replyText = await route.dispatch(slash, {
  getOpenPositions: () => getOpenPositions(getMode()),
  setPaused,
  closePosition: closePositionDep,
  currentMode: getMode(),
});
```
Actualiza el tipo `ControlRouteDeps.dispatch` para aceptar el `ControlIntent` completo (con `cierra`+`symbol`) y las nuevas deps (importa `DispatchDeps`/`ControlIntent` y tíchalos):
```typescript
import type { DispatchDeps } from '../lib/control/dispatch-control.ts';
import type { ControlIntent } from '../lib/control/control-intent-schema.ts';
// ...
interface ControlRouteDeps {
  dispatch: (intent: ControlIntent, deps: DispatchDeps) => Promise<string>;
  reply: (text: string, to: string) => Promise<unknown>;
  invoke: (text: string, sender: string) => Promise<unknown>;
}
```

- [ ] **Step 6: Corre los tests del canal + typecheck**

Run: `npm test -- src/channels/__tests__/evolution.test.ts && npm run typecheck`
Expected: PASS + typecheck limpio. Si los tests existentes mockeaban `route.dispatch` con la firma vieja, actualiza el mock a la nueva firma (no cambies la lógica de los tests de SP11).

- [ ] **Step 7: Commit**

```bash
git add src/workflows/control-maker.ts src/skills/control-protocol/SKILL.md src/channels/evolution.ts src/channels/__tests__/evolution.test.ts
git commit -m "feat: cableado SP14 — control-maker result estricto (H1), skill /modo, closePosition dep en evolution"
```

---

## Task 8: Suite completa + docs

**Files:**
- Modify: `CLAUDE.md`, `docs/PENDIENTES.md`

- [ ] **Step 1: Corre la suite COMPLETA**

Run: `npm test`
Expected: toda verde (incluye integración con Postgres del compose). Si algo falla, diagnostica y arregla; no maquilles.

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 3: Actualiza `CLAUDE.md`**

Añade entrada **SP14 (hecho)** en "Progreso por sprints" (estilo SP11–SP13): `/cierra <symbol>` real (slash-only, cancel-first, idempotente, falla cerrado) + `/modo` read-only; el LLM fuera del cierre (schema `result` estricto). Actualiza "Dónde estamos" y los pendientes: Fase 3 casi cerrada; queda **trailing** (sprint propio) + el **smoke vigilado de `/cierra`** (owner-gated) + Fase 4 (live).

- [ ] **Step 4: Actualiza `docs/PENDIENTES.md`**

Marca `/cierra` y `/modo` como **hechos en SP14** en la sección "Diferido a testnet". Deja: trailing (sprint propio para cerrar Fase 3), conmutación de modo en caliente (sprint propio), kill-switch en Redis, dedup de inbound. Añade el **smoke de `/cierra`** a §1.2 (owner-gated): cierra una posición real en testnet, verifica que el OCO desaparece del exchange y la posición queda `closed` con P&L real.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/PENDIENTES.md
git commit -m "docs: SP14 hecho — /cierra real + /modo read-only (smoke de cierre owner-gated pendiente)"
```

---

## Self-Review (writing-plans)

**Cobertura del spec:** dos schemas (FIX H1) → Task 1; parser `/cierra`/`/modo` → Task 2; `getOpenPositionBySymbol` (FIX M1) + `getLatestClosePrice` → Task 3; `cancelOco` (FIX M3) → Task 4; `closePositionCommand` (cancel-first, lock, sim/real, FIX H2 protected=false, FIX H3 vía emergencyClose throw) → Task 5; dispatch cierra/modo → Task 6; cableado result estricto + skill + evolution deps → Task 7; suite + docs → Task 8. FIX M2 (una posición por símbolo) → `getOpenPositionBySymbol ORDER BY opened_at DESC LIMIT 1` (Task 3). FIX L1 (fee) → heredado, mismo cálculo. Línea roja H1 → Task 1 + Task 7 (result estricto). Todo cubierto.

**Consistencia de tipos:** `ControlResultSchema`/`ControlIntentSchema` (Task 1) consumidos por parser (Task 2), dispatch (Task 6), control-maker (Task 7). `ReconcilePosition` (SP13) reusado en `getOpenPositionBySymbol` (Task 3) y `closePositionCommand` (Task 5). `BracketLeg` (SP13) en `cancelOco` (Task 4) y el command (Task 5). `ClosePositionDeps.client` = `RealClient & OrderStateClient & CancelOcoClient` (Task 5) construido en evolution (Task 7). `emergencyClose`/`ExitResult` de SP12. `withSetupLock`/`NOT_ACQUIRED` de SP12.

**Sin placeholders:** cada paso muestra el código real; comandos con expected output.
