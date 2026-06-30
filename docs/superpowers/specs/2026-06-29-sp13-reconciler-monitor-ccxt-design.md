# SP13 — Reconciler/monitor ccxt + frescura OHLCV (cierra Fase 3, habilita el loop testnet continuo)

> **Fecha:** 2026-06-29 · **Fase:** 3 (testnet) · **Predecesor:** SP12 (ejecutor real + OCO residente).
> **Construye sobre:** SP12 dejó marcadores durables crash-safe (`positions.protected=false`,
> `orders.status='pending_execution'` con fill, `orders.status='pending'` sin fill) y declaró una
> **precondición dura I1** (doble-compra secuencial tras fill incierto). SP13 cierra ese hueco y hace
> que el loop testnet **funcione desatendido**.

## Principio rector (sin cambios)

El LLM tiene **juicio, no gatillo**: sigue en **sombra** (`shadow_verdicts`) como en Fase 2. Todo lo
que SP13 añade —reconciliar contra el exchange, detectar cierres reales, refrescar velas— es **código
determinista, idempotente y auditable**. Ninguna tool de mutación entra al `tools:[]` de un agente. El
reconciler y el monitor llaman a ccxt directamente desde código de orquestación, nunca desde el bucle
de tool-calling de un modelo.

## Objetivo

Habilitar el **loop testnet continuo y desatendido**. Para eso, tres subsistemas deterministas sobre el
ejecutor real de SP12:

1. **Reconciler ccxt** (arranque + tick periódico) que reconcilia los marcadores durables de SP12
   contra el exchange — **cierra la precondición I1**.
2. **Monitor de cierres reales** (testnet/live) que detecta el fill server-side del OCO y cierra la
   posición en DB con **P&L de fills reales**.
3. **Frescura OHLCV** que mantiene `kairos.ohlcv_candles` al día para que el scanner siga generando
   señales sin intervención.

Más un **gate de dedup consciente de entradas sin resolver** (lo que cierra la doble-compra por
seguridad) y un **cambio contenido en SP12** (`clientOrderId` determinista) que habilita la
identificación de entradas inciertas.

## Decisiones de diseño (tomadas en brainstorming)

- **Alcance: trío + trailing diferido.** SP13 = reconciler + monitor de cierres reales + frescura
  OHLCV. El **trailing** (cancelar OCO + recolocar SL más arriba) es un camino de mutación nuevo con su
  propia idempotencia/compensación/crash-safety; se difiere a un sprint propio (YAGNI — no es necesario
  para correr el loop con seguridad).
- **Mecanismo del monitor: polling REST**, no WS. ARCHITECTURE §15.1 fija "REST autoritativo, WS
  best-effort": el camino que cierra dinero (detectar el fill del OCO, registrar P&L) debe ser
  determinista y fiable → `fetchOrder`/`fetchOrderTrades` a cadencia `MONITOR_INTERVAL_MS`. El WS
  (precio sub-cadencia) pertenece al trailing diferido.
- **Política del reconciler ante posición real abierta y desprotegida** (`protected=false`, viva en el
  exchange, **sin OCO**): **re-proteger** (recolocar OCO con el `sl`/`tp` ya persistidos) y
  `protected=true`. Si el OCO vuelve a fallar → cae a cierre de emergencia. Mantiene viva la operación y
  reusa `placeOco` de SP12.
- **Cadencia del reconciler: arranque + tick periódico.** Corre una vez antes de que el scanner dispare
  (garantía I1 del spec) y luego como tick repetible. Resuelve entradas inciertas in-flight → el setup
  se auto-sana sin reinicio manual (necesario para un loop que corre días).
- **`clientOrderId` determinista** = `signalId` (= `idempotency_key`, ULID de 26 chars; cabe en el
  límite de Binance, ~36). `placeEntry` lo manda; el reconciler lo reconstruye desde la fila de la
  orden y hace `fetchOrder` puntual. Sin esto, una entrada incierta (`pending`/`pending_execution`, sin
  `exchange_order_id`) solo se podría buscar por emparejamiento difuso tiempo/qty — frágil y rechazado.

## Por qué un reconciler "de arranque" no basta para cerrar I1 (matiz del spec de SP12)

El spec de SP12 enmarcó I1 como "reconciliar antes de que el scanner dispare". En un loop **continuo**
(sin reinicios) eso es insuficiente: si la entrada de la señal A queda incierta **a mitad de corrida**
(NetworkError en la respuesta de `placeEntry` cuando la orden sí llenó), A devuelve `pending_execution`,
no abre posición y libera el lock; una señal B posterior del mismo setup pasaría el re-check
`hasOpenPositionForSetup` (positions.ts:150 — solo mira `positions` con `status='open'`, **no** mira
órdenes) y colocaría una segunda compra real.

La **seguridad** (no doble-compra) la cierra hacer el **gate de dedup consciente de entradas sin
resolver**: un setup con una orden de entrada `pending`/`pending_execution` cuenta como "ocupado" → B se
bloquea. Eso solo elimina la doble-compra, sin depender de la cadencia del reconciler. Lo que el
reconciler periódico añade es **auto-sanación**: resuelve la entrada incierta contra el exchange para
que el setup no quede bloqueado hasta un reinicio manual.

> **Resumen de la garantía I1:** dedup setup-aware (gate) ⇒ seguridad; reconciler arranque+periódico ⇒
> disponibilidad (el setup se libera al confirmar que A llenó —posición abierta— o que no llenó —orden
> `canceled`—).

## Alcance

### Dentro de SP13

1. **Cambio en SP12 — `clientOrderId` determinista** en `placeEntry` (hilvanado por `PlaceEntryArgs`;
   `params.clientOrderId = signalId`). Contenido, sin tocar la máquina de estados de `executeOrderReal`.
2. **Gate de dedup consciente de entradas sin resolver** — un setup con entrada `pending`/
   `pending_execution` cuenta como ocupado. Aplicado en los dos puntos de dedup (pre-check de
   `evaluateCandidate` + re-check dentro del lock en `executeOrderReal`).
3. **Reconciler ccxt** (`src/lib/reconcile/exchange-reconcile.ts`) — arranque + tick periódico.
4. **Monitor de cierres reales** (`src/lib/monitor/monitor-real.ts`) — despachado por modo en el worker.
5. **Frescura OHLCV** (`src/lib/market-data/refresh.ts`) — job BullMQ repetible.
6. **Soporte**: `getFillsForOrder(orderId)` (lectura de fills, hoy inexistente — el repo solo tiene
   `insertFill`); nuevas constantes de cadencia en `limits.ts`; cableado de workers/queues + shutdown.

### Fuera de SP13 (diferido, consciente)

- **Trailing** (cancelar OCO residente + recolocar SL más arriba según precio en vivo). Camino de
  mutación nuevo → sprint propio. Requiere precio sub-cadencia (WS, §15.1) y su propia compensación.
- **SP14**: `/cierra <symbol>` (close_position idempotente real) y `/modo <sim|testnet|live>` (control
  que toca dinero).
- **Heartbeat/supervisión de proceso long-lived** (§15.5) y el stream WS de liquidaciones — no
  necesarios para el loop REST.

## Arquitectura

Despacho por modo, igual que SP12 (`evaluate-candidate.ts` despacha `executeOrderSim` vs
`executeReal`). SP13 replica ese patrón en el **monitor** (sim barra-a-barra vs real order-state) y
añade dos componentes recurrentes nuevos (reconcile, refresh) que solo hacen trabajo real en
`testnet|live` (en `sim` no hay exchange que consultar).

```
worker (arranque)
  └─ runExchangeReconcile()           ← ANTES del scanner (garantía I1)
  └─ scan-tick / monitor-tick / reconcile-tick / ohlcv-refresh-tick  (BullMQ repetibles)
```

### Componente A — Reconciler ccxt · `src/lib/reconcile/exchange-reconcile.ts`

> El reconciler delgado de SP6 (`startup-reconcile.ts`, solo audita estados DB sin ccxt) **se conserva**
> para `sim` y como auditoría barata; el reconciler ccxt es el camino real (`testnet|live`). El worker
> llama al ccxt en arranque para modos reales y al delgado en `sim`.

Inyectable (deps con `client`, `placeOco`, `emergencyClose`, finders de repo) para testear cada caso con
mocks. Best-effort **por ítem**: el fallo de una reconciliación audita y el reconciler sigue con el
siguiente (no tumba el arranque). Por cada marcador durable:

**A.1 — Entrada sin resolver** (`orders.status IN ('pending','pending_execution')` y sin posición para
su decisión). Reconstruye `clientOrderId` desde `idempotency_key`. `fetchOrder(undefined, symbol,
{ clientOrderId })` (o `fetchOpenOrders`/`fetchClosedOrders` + match por `clientOrderId` si el exchange
no soporta lookup directo — a verificar contra ccxt real).

- Exchange dice **llenada** (`status` closed/filled, `filled>0`): `fetchOrderTrades` → registra fill(s)
  reales (idempotente: salta si `getFillsForOrder` ya tiene el fill), abre posición (`protected=false`)
  **si no existe ya** (guarda contra el índice `idx_positions_open_setup`), **re-protege** (`placeOco`)
  → `protected=true`, marca la orden `filled`. Audita `reconcile_entry_filled`.
- Exchange dice **no llenada / no existe**: marca la orden `canceled`. Audita `reconcile_entry_void`.
  El setup queda libre.

**A.2 — Posición abierta desprotegida** (`positions.status='open' AND protected=false`). Consulta las
legs OCO por `exchange_order_id` (de `orders` purpose sl/tp con `parent_id` = entry) vía `fetchOrder`, o
`fetchOpenOrders(symbol)`.

- Posición **cerrada en el exchange** (legs llenadas/canceladas y sin balance base) → `fetchOrderTrades`
  de la leg tocada → cierra en DB con **P&L de trades reales** (`closeOpenPosition` idempotente +
  `closeBracketLegs`). Audita `reconcile_position_closed`.
- Posición **abierta + OCO presente** (legs vivas en el exchange) → solo `setPositionProtected(true)`
  (el crash fue entre `placeOco` ok y el flip de `protected`). Audita `reconcile_reprotected_noop`.
- Posición **abierta + sin OCO** → **re-protege** (`placeOco` con `sl`/`tp` de la fila) →
  `protected=true`. Si `placeOco` falla → **cierre de emergencia** (`emergencyClose`, cierra DB con P&L
  real). Audita `reconcile_reprotected` / `reconcile_reprotect_emergency`.

> **Idempotencia del reconciler:** cada acción es condicional al estado DB actual (`closeOpenPosition`
> solo cierra si `status='open'`; `openPosition` choca con el índice si ya existe; `getFillsForOrder`
> evita doble-registro de fills). Correr el reconciler dos veces seguidas es inocuo.

### Componente B — Monitor de cierres reales · `src/lib/monitor/monitor-real.ts`

`runMonitorTickReal(asOf, deps)`, despachado por modo en el worker (`sim → runMonitorTick`
barra-a-barra **intacto**; `testnet|live → runMonitorTickReal`). Inyectable, best-effort por posición
(igual que `monitor-tick` hoy: un fallo audita `monitor_error` y el tick sigue). Solo procesa
posiciones **protegidas** (`protected=true`); las desprotegidas son trabajo del reconciler.

Por cada posición abierta protegida:
- Lee las legs OCO de su decisión (`orders` purpose sl/tp con `exchange_order_id`).
- `fetchOrder(legExchangeId, symbol)` por leg.
- Si una leg **llenó** (`status` closed/filled, `filled>0`): `fetchOrderTrades` → exit real;
  `realizedPnl = (exitAvg − entry)·qty − exitFee − entryFee`; registra fill de salida (`insertFill`
  contra la leg), `closeOpenPosition`, `closeBracketLegs(hitType)` (Binance auto-cancela la hermana
  server-side; el update DB la marca canceled), audita `position_closed_real`, notify best-effort
  (template, sin LLM).
- Ambas abiertas → nada. El OCO server-side es la autoridad; el monitor **no resuelve velas** en real.

> **Riesgo residual L1 (heredado de SP12):** STOP_LOSS_LIMIT puede no llenar en un *gap*. Si el monitor
> ve la leg SL en estado `canceled`/`expired` sin fill **y** la posición sin balance base resuelto, lo
> trata como hueco a reconciliar (delega al reconciler / cierre de emergencia), no como cierre limpio.
> En testnet (play money) es aceptable; la red real ante gap se endurece en Fase 4.

### Componente C — Frescura OHLCV · `src/lib/market-data/refresh.ts`

`refreshOhlcv(deps)`: por cada `symbol × timeframe` de `SYMBOLS`/`TIMEFRAMES` (config.ts), lee la última
`open_time` almacenada (`getLatestCandleTime(symbol, timeframe)`), `fetchClosedOHLCV` (cliente
**público**, sin API key — reusa `createPublicClient`) desde ahí, `upsertCandles` (idempotente, ON
CONFLICT DO NOTHING). Job BullMQ repetible a `OHLCV_REFRESH_INTERVAL_MS` (≤ `MONITOR_INTERVAL_MS`).
Best-effort: fallo de fetch de un símbolo → audita `ohlcv_refresh_failed` y sigue con el siguiente.
Mantiene al scanner alimentado en el loop desatendido. Aplica a **todos** los modos (el scanner corre
sobre velas en sim también), pero solo importa para corridas continuas.

### Componente D — Gate de dedup consciente de entradas sin resolver

Nueva fn de repo `isSetupOccupied(strategyId, symbol, mode)` (o `hasUnresolvedEntryForSetup` +
composición con `hasOpenPositionForSetup`): true si hay posición abierta **o** una orden de entrada
`pending`/`pending_execution` para ese setup. Aplicada en los **dos** puntos de dedup:
- Pre-check en `evaluateCandidate` (antes de encolar/ejecutar).
- Re-check dentro del lock en `executeOrderReal` (línea 49 hoy usa `hasOpenForSetup`).

> Esto es lo que cierra la doble-compra **por seguridad**, independiente de la cadencia del reconciler.
> El `sim` no se ve afectado (en sim la entrada llena en la misma transacción → nunca hay entrada
> `pending`/`pending_execution` colgada).

## Datos / esquema

Sin columnas nuevas. SP13 **lee** estados que SP12 ya persiste y **añade** lecturas:
- `getFillsForOrder(orderId)` → `SELECT ... FROM kairos.fills WHERE order_id = $1 ORDER BY ts` (hoy el
  repo `fills.ts` solo tiene `insertFill`; el reconciler/monitor necesitan leer para idempotencia y P&L).
- `getLatestCandleTime(symbol, timeframe)` → `SELECT max(open_time) ...` para el cursor del refresh.
- `findUnresolvedEntries(mode)` / `findUnprotectedPositions(mode)` → finders del reconciler (status
  `pending`/`pending_execution`; `protected=false`).

Constantes nuevas en `src/lib/execution/limits.ts`:
- `RECONCILE_INTERVAL_MS` (default p.ej. `5 * 60_000`).
- `OHLCV_REFRESH_INTERVAL_MS` (default `MONITOR_INTERVAL_MS`, validado ≤ `MONITOR_INTERVAL_MS`).

## Manejo de errores

- **NetworkError** (recuperable) → retry con backoff (reusa el patrón de `place-oco.ts` de SP12);
  **ExchangeError** (no recuperable) → no-retry + audit. Jerarquía verificada contra ccxt real.
- **Best-effort por ítem** en reconciler y monitor: el fallo de una posición/orden audita y el tick
  sigue. Nunca un fallo de reconciliación tumba el arranque o el worker.
- **Notificación** best-effort (template, `notifyBestEffort`), separada de la ejecución — igual que hoy.
- **Degradación OHLCV**: fallo de fetch de un símbolo audita y el refresh continúa; el scanner opera con
  las velas que tenga (REST autoritativo, §15.1 — una caída degrada, no bloquea).

## Cableado (worker)

`src/worker.ts`:
- Arranque: para `testnet|live` corre `runExchangeReconcile()` **antes** de montar el scan-tick
  (reemplaza/extiende la llamada actual a `runStartupReconcile()` que queda para `sim`).
- Dos workers/queues BullMQ repetibles nuevos: `reconcile-tick` (`RECONCILE_INTERVAL_MS`) y
  `ohlcv-refresh-tick` (`OHLCV_REFRESH_INTERVAL_MS`), con `upsertJobScheduler` (patrón existente).
- El `monitor-tick` despacha por modo: `sim → runMonitorTick`, `testnet|live → runMonitorTickReal`.
- Todos los nuevos closeables entran al `createShutdown` existente (graceful shutdown de SP6).

## Verificación

- **Unit** (mock del cliente ccxt por cada caso de estado de orden): lógica de decisión del reconciler
  (A.1/A.2, los ~6 desenlaces), `runMonitorTickReal` (leg llena / ambas abiertas / leg fallida),
  `refreshOhlcv` (fetch+upsert, fallo por símbolo), `isSetupOccupied`, `clientOrderId` determinista en
  `placeEntry`.
- **Integración** (Postgres del compose): `getFillsForOrder`, `getLatestCandleTime`,
  `findUnresolvedEntries`/`findUnprotectedPositions`, `isSetupOccupied`.
- **Smoke vigilado owner-gated** (fuera de CI): con `KAIROS_MODE=testnet`, validar contra Binance
  testnet real (a) que el reconciler resuelve una entrada/posición de prueba vía `fetchOrder`/
  `fetchOrderTrades`, y (b) que el monitor detecta el fill server-side del OCO y cierra con P&L real.
  Valida las llamadas ccxt reales (la mayor incógnita), igual que el gate de SP12.
- **Cobertura 80%.** Córrelo de verdad antes de afirmar verde.

## Resultado

Cierra la Fase 3: **habilita el loop testnet continuo y desatendido**. I1 cerrado (gate de dedup +
reconciler), las posiciones cierran de verdad con P&L de fills reales, y el scanner se mantiene fresco
sin intervención. El LLM sigue en sombra. Pendiente tras SP13: trailing (sprint propio), SP14
(`/cierra`, `/modo`) y Fase 4 (live, poco capital).
