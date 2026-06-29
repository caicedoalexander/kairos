# SP12 — Camino del dinero real en testnet (entrada + OCO residente)

> **Fase 3 (Testnet) — primer sub-proyecto.** Decompone Fase 3 en SP12 (este, entrada real + OCO),
> SP13 (salida real + **reconciler/monitor con ccxt** + ohlcv al día) y SP14 (control que toca dinero:
> `/cierra`, `/modo`). SP12 cablea la ejecución real y deja la posición protegida server-side **dentro
> de una ejecución sin crash**; los orphans por crash/fill-incierto quedan como **marcadores durables**
> que el reconciler de SP13 resuelve.
>
> Fecha: 2026-06-29. Construye sobre Fase 1 (loop determinista sim cerrado) y Fase 2 (razonamiento LLM
> en sombra, completa). Claves de Binance testnet ya validadas (`fetchBalance` OK, sandbox por
> `KAIROS_MODE != live`).
>
> **Revisado por `kairos-design-reviewer` (v1 → bloqueado); este es v2 con C1/H1/H2/H3/H4 + MEDIUM/LOW
> plegados.**

## Principio rector (no negociable)

**El LLM tiene juicio, no gatillo.** SP12 NO cambia esto. En testnet el camino del dinero sigue
ejecutando el **veredicto determinista** (`buildDeterministicVerdict`); el LLM corre en sombra
(`shadow_verdicts`) igual que en Fase 2. Todo lo que toca el exchange es código determinista,
idempotente y auditable. Ninguna tool de mutación entra al `tools:[]` de un agente.

## Objetivo

Que `KAIROS_MODE=testnet` coloque **órdenes reales** en Binance Spot testnet por cada señal que hoy
ejecutaría en sim, con la misma idempotencia y auditoría, dejando un **OCO residente (SL+TP)
server-side** tras el fill de entrada. Cuando el OCO no se puede colocar tras un fill real, un
**cierre de emergencia** aplana la posición. Lo que el crash/fill-incierto deje colgado se marca de
forma **durable** para el reconciler de SP13 — SP12 no pretende cerrar ese hueco (ver §Seguridad).

## Seguridad: qué garantiza SP12 y qué no (honesto)

- **Garantiza**: dentro de una ejecución que no crashea, la posición real queda protegida server-side
  (OCO residente) o se aplana (cierre de emergencia). El SL/TP nunca espera a una llamada LLM.
- **NO garantiza** (queda para SP13): (a) un **crash** del proceso entre el fill de entrada y la
  confirmación del OCO; (b) un **fill incierto** (NetworkError en la respuesta de `placeEntry` cuando
  la orden sí llenó). §18 (líneas 820-828) asigna ese hueco al **monitor/reconciler**, diferido a SP13.
- **Marcadores durables que SP12 deja para el reconciler de SP13**:
  - `positions.protected = false` → posición real abierta cuya protección OCO **no** está confirmada
    (incluye el crash-en-ventana, porque `protected` arranca en `false` y sólo se pone `true` tras
    confirmar el OCO).
  - `orders.status = 'pending_execution'` → entrada incierta que pudo haber llenado en el exchange.
- **Gate operativo**: en SP12 sólo se corre **smoke vigilado** (una señal, owner mirando). El **loop
  testnet continuo y desatendido se habilita en SP13**, cuando el reconciler cierre el hueco.

## Alcance

### Dentro de SP12

1. **Despacho por modo** en `evaluateCandidate`: `sim → executeOrderSim` (sin cambios);
   `testnet|live → executeOrderReal`.
2. **Lock Redis por SETUP** (`withSetupLock(strategyId, symbol, mode)`) — claim **antes** de tocar el
   exchange (§821). Por setup, no por señal: serializa señales distintas del mismo setup (C1).
3. **Ejecutor real** (`executeOrderReal`): entrada *limit marketable IOC capada* (con
   precisión/minNotional/stepSize) → fills reales → abre posición (`protected=false`) → **OCO
   residente** (SL stop-limit + TP limit, por `qty` **neta de fee**) → `protected=true` → persistencia
   → audit.
4. **Compensación**: fallo de OCO tras fill real → retry breve → **cierre de emergencia** (market IOC
   por qty neta). Carrera de setup (23505 en `openPosition`) **dentro** del ejecutor → también
   cierre de emergencia (la compra real ya ocurrió; en real no hay rollback).
5. **Precisión y mínimos** (`amountToPrecision`/`priceToPrecision`, `minNotional`, `stepSize`,
   `LOT_SIZE`) antes de cada `createOrder`; size por debajo del mínimo → skip auditado, no crash.
6. **Singleton ccxt autenticado** (evita conflictos de nonce).
7. **Marcador durable** `positions.protected` (columna nueva) + nuevos estados `zero_fill`,
   `emergency_closed`.

### Fuera de SP12 (diferido, consciente)

- **SP13**: reconciler de arranque con ccxt (consume `positions.protected=false` y
  `orders.status='pending_execution'`, re-protege o aplana); monitor que detecta cierres reales vía
  ccxt + P&L desde fills reales + trailing (recolocar el OCO); `ohlcv_candles` al día; **habilita el
  loop continuo**.
- **SP14**: `/cierra <symbol>` (close_position idempotente real) y `/modo <sim|testnet|live>`.

> **Desviación declarada de §18.2 (slippage).** §18.2 especifica un **book-walk pre-trade** + guards de
> slippage. SP12 usa en su lugar un **cap fijo** sobre `refPrice` (`slippage_bps = 5`, reúso de
> `DEFAULT_SIM_PARAMS`). Justificación: testnet valida *plumbing*, no microestructura; el book-walk
> requiere `fetchOrderBook` y lógica de profundidad fuera de alcance. El cap fijo es conservador
> (la IOC capada nunca llena peor que `refPrice·1.0005`). El book-walk se reintroduce en el
> endurecimiento de Fase 4.

## Arquitectura

`executeOrderReal` es el hermano determinista de `executeOrderSim`. Comparte contrato
(`ExecuteOrderSimParams`-compatible; devuelve `ExecutionResult`) pero sustituye el `simulateFill`
paramétrico por llamadas ccxt reales y añade la colocación del OCO server-side. Diferencia estructural
con sim: en sim **una transacción DB** abarca todo (la entrada se "llena" sintéticamente dentro de la
tx, y un 23505 es un **rollback inocuo**); en real la entrada y el OCO son **llamadas al exchange
fuera de cualquier transacción DB** y un 23505 ocurre **después de una compra real** → la atomicidad
se sustituye por una **máquina de estados con compensación** (cierre de emergencia).

### Orden invariante: claim → exchange (§821)

```
withSetupLock(strategyId, symbol, mode)      ← mutua exclusión por SETUP (Redis SET NX PX)
  └─ claimEntryOrder (INSERT ON CONFLICT)    ← idempotencia DURABLE (UNIQUE idempotency_key=signalId)
       └─ placeEntry (ccxt)                  ← PRIMERA llamada al exchange
```

- **Lock por setup, no por señal (C1):** el dedup de Kairos es per-setup (`strategyId+symbol+mode`,
  índice `idx_positions_open_setup`). Dos señales distintas del mismo setup tienen `signalId` distinto;
  un lock por `signalId` no las serializaría y **ambas comprarían de verdad**. El lock por setup las
  serializa: la segunda no adquiere el lock → `deduped` antes de tocar el exchange.
- **Idempotencia durable:** sigue siendo el `UNIQUE(idempotency_key=signalId)` en DB; sobrevive a un
  Redis caído/evictado y a un reintento de BullMQ del **mismo** job.
- **Fail-closed (M2):** `withSetupLock` usa `REDIS_URL` (cache/locks; distinto de `REDIS_BULLMQ_URL`).
  Si Redis está caído, **falla cerrado** (no ejecuta sin lock) → la señal queda sin procesar y se
  reintenta; el `UNIQUE` sigue siendo la red durable. En testnet preferimos no comprar sin exclusión.
- **TTL (M3):** `SET NX PX` con TTL que acota el **peor caso** entrada + OCO(retries) + emergencia
  (constante `SETUP_LOCK_TTL_MS`, p.ej. 45 000). Si aun así expira, el `UNIQUE` es la única garantía
  restante (aceptable y documentado). Release en `finally` sólo si el token sigue siendo mío
  (check-and-del, script Lua o GET+DEL condicional).

## Componentes (archivos)

| Archivo | Acción | Responsabilidad |
|---------|--------|-----------------|
| `src/lib/execution/setup-lock.ts` | crear | `withSetupLock(strategyId, symbol, mode, fn)`: `SET kairos:lock:setup:<s>:<sym>:<mode> token NX PX ttl`; ejecuta `fn`; release condicional por token. No adquiere → sentinela `not_acquired`. Fail-closed si Redis no responde. |
| `src/lib/ccxt-client.ts` | modificar | `getAuthenticatedClient()` **singleton** (una instancia/proceso) con `loadMarkets()` perezoso. Mantener `createAuthenticatedClient` como factory interno. |
| `src/lib/execution/real-order/precision.ts` | crear | Helpers puros sobre el `market` de ccxt: `capPrice`, `roundAmount` (stepSize, hacia abajo), `roundPrice` (tickSize), `meetsMinNotional`, `netSellableQty(filledQty, fee, market)`. Testeable sin red. |
| `src/lib/execution/real-order/place-entry.ts` | crear | `placeEntry(client, args)`: aplica precisión; verifica `minNotional`/`minQty` (si no cumple → `{below_min:true}`); `createOrder(symbol,'limit','buy',amt,capPrice,{timeInForce:'IOC'})`; normaliza a `{filledQty, avgPrice, fee, feeBase, exchangeOrderId, raw}`. |
| `src/lib/execution/real-order/place-oco.ts` | crear | `placeOco(client, {symbol, qty, sl, tp, market})`: `qty` ya **neta de fee y redondeada**; leg SL = STOP_LOSS_LIMIT con `stopPrice=sl` y `limitPrice=roundPrice(sl·(1−STOP_LIMIT_OFFSET_BPS/1e4))`; leg TP = TAKE_PROFIT/LIMIT_MAKER a `tp`. **Retry breve** (NetworkError→backoff; ExchangeError→no-retry). Devuelve `{orderListId, slOrderId, tpOrderId}` o lanza. |
| `src/lib/execution/real-order/emergency-close.ts` | crear | `emergencyClose(client, {symbol, qty})`: `createMarketSellOrder` IOC por qty neta; normaliza `{exitPrice, exitFee, exchangeOrderId}`. |
| `src/lib/execution/execute-order-real.ts` | crear | Orquesta la máquina de estados (ver Flujo). Deps inyectables (`client`, `placeEntry`, `placeOco`, `emergencyClose`) para test. |
| `src/db/repositories/orders.ts` | modificar | `claimEntryOrder`/`insertBracketLeg` aceptan `exchangeOrderId?`; nuevo `setOrderExchangeId(id, exchangeOrderId, exec)`. |
| `src/db/repositories/positions.ts` | modificar | `openPosition` acepta `protected?: boolean` (default **true**, para no tocar sim); nuevo `setPositionProtected(id, value, exec)`. |
| `src/db/migrate.ts` (o SQL de esquema) | modificar | `ALTER TABLE kairos.positions ADD COLUMN protected boolean NOT NULL DEFAULT true`. (Default true = posiciones sim/históricas se consideran protegidas por su monitor paper.) |
| `src/orchestration/evaluate-candidate.ts` | modificar | Despacho por modo; ramas de notify para `zero_fill`/`emergency_closed`. |
| `src/lib/execution/types.ts` | modificar | `ExecutionResult.status` suma `'zero_fill' \| 'emergency_closed'`. |
| `src/lib/execution/limits.ts` | modificar | Constantes nuevas: `SETUP_LOCK_TTL_MS`, `STOP_LIMIT_OFFSET_BPS`. |

**Reúso sin cambio de firma:** `insertFill`, `closePositionOnBracket`/`closePosition`,
`appendAuditLog`, `notifyBestEffort`, `getOrderByIdempotencyKey`, `updateOrderStatus`,
`isOpenSetupViolation` (se reusa para detectar la carrera de setup también en el camino real).

## Flujo de datos — `executeOrderReal`

```
1. withSetupLock(strategyId, symbol, mode, async () => {
       not_acquired → return { status:'deduped' }   (otra señal del mismo setup va en curso)
2.    claim = claimEntryOrder(idem=signalId, …)
        !claim → getOrderByIdempotencyKey → return { status:'duplicate' }
3.    entry = placeEntry(client, {symbol, size, refPrice, slippageBps, market})   ← EXCHANGE
        entry.below_min → updateOrderStatus(claim.id,'canceled'); audit 'entry_below_min'
                          → return { status:'zero_fill' }   (degradación limpia, no crash)
        throw (NetworkError/ExchangeError) → updateOrderStatus(claim.id,'pending_execution')
                          audit 'entry_uncertain' → return { status:'pending_execution' }
        entry.filledQty === 0 → updateOrderStatus(claim.id,'canceled')
                          audit 'entry_zero_fill' → return { status:'zero_fill' }
4.    // entry llenó (full/parcial): tengo BTC real
        sellableQty = netSellableQty(entry.filledQty, entry.feeBase, market)   // neto de fee, ↓stepSize
        try {
          insertFill(claim.id, entry.avgPrice, entry.filledQty, entry.fee)
          positionId = openPosition({entry:entry.avgPrice, size:entry.filledQty, sl, tp,
                                     entryFee:entry.fee, protected:false, …})   // ← protected=false
          updateOrderStatus(claim.id,'filled'); setOrderExchangeId(claim.id, entry.exchangeOrderId)
        } catch (e) {
          // 23505: carrera de setup — la compra real YA ocurrió, no hay rollback que la deshaga
          if (isOpenSetupViolation(e)) {
             exit = emergencyClose(client, {symbol, qty:sellableQty})           ← EXCHANGE
             → return { status:'emergency_closed', reason:'setup-race' }   (o unprotected si falla)
          } else throw e
        }
5.    try {
          oco = placeOco(client, {symbol, qty:sellableQty, sl, tp, market})      ← EXCHANGE (retry)
          insertBracketLeg(sl, exchangeOrderId=oco.slOrderId)
          insertBracketLeg(tp, exchangeOrderId=oco.tpOrderId)
          setPositionProtected(positionId, true)                                // ← confirma protección
          audit 'order_filled_real'(orderListId) → return { status:'filled', positionId, … }
      } catch {
          exit = emergencyClose(client, {symbol, qty:sellableQty})              ← EXCHANGE
          insertFill(cierre); closePosition(positionId, exit); audit 'oco_failed_emergency_closed'
          return { status:'emergency_closed', positionId, … }
          // si emergencyClose TAMBIÉN falla (o el setup-race emergency falla):
          //   positions.protected sigue false (marcador durable), audit 'emergency_close_failed',
          //   alerta MÁXIMA, re-lanza → job 'failed' → lo retoma el reconciler de SP13.
      }
   })
```

**Parámetros:** `refPrice = verdict.entry`; `slippageBps = DEFAULT_SIM_PARAMS.slippage_bps` (= 5);
`size = riskResult.adjustedSize`. `market = client.market(symbol)` (de `loadMarkets`).

**Fill parcial:** posición y OCO se abren por `filledQty`/`sellableQty` reales (el remanente IOC ya se
canceló solo). No se persigue.

**`protected` (marcador durable, crash-safe):** se inserta en `false`; sólo `setPositionProtected(true)`
**después** de confirmar el OCO. Un crash en la ventana deja `protected=false` → el reconciler de SP13
lo encuentra. Las queries de exposición/dedup tratan la posición como abierta igual (es exposición real).

## Estados y notificación

| Status | Significado | Posición | Notify (best-effort) | Audit |
|--------|-------------|----------|----------------------|-------|
| `filled` | Entrada llenó + OCO residente confirmado | abierta, `protected=true` | `✅ {symbol}: entrada @ {price} ({qty}) sl={sl} tp={tp} (OCO residente)` | `order_filled_real` |
| `zero_fill` | IOC capado no cruzó, o size < mínimo | no se abre | `➖ {symbol}: sin posición (IOC no cruzó / size < mínimo)` | `entry_zero_fill` / `entry_below_min` |
| `emergency_closed` | OCO falló (o carrera setup) → aplanada | abierta→cerrada | `🚨 {symbol}: OCO no colocado — posición aplanada por emergencia` | `oco_failed_emergency_closed` |
| `pending_execution` | Entrada incierta (timeout/red/ExchangeError) | no se asume; orphan-marker | `⏳ {symbol}: ejecución pendiente (no asumida). idem={idem}` | `entry_uncertain` |
| `duplicate` | `UNIQUE` tomado (reintento mismo job) | — | — (silencioso) | — |
| `deduped` | Lock de setup no adquirido (otra señal del setup) | — | — (silencioso) | — |

> Caso peor `emergency_close_failed`: posición real viva con `protected=false`; alerta máxima + job
> `failed`. Es el único camino con exposición residual; riesgo aceptado de testnet (play money),
> retomado por el reconciler de SP13 vía el marcador `protected=false`.

## Manejo de errores (clasificación ccxt)

- **Reintentable**: `NetworkError`, `RequestTimeout`, `RateLimitExceeded`, `ExchangeNotAvailable`,
  `DDoSProtection`. **No reintentable**: `ExchangeError`, `AuthenticationError`, `InsufficientFunds`,
  `InvalidOrder`, `NotSupported`.
- **`placeEntry`**: NO reintenta ante `NetworkError` (la entrada es *incierta* — reintentar ciegamente
  duplicaría) → `pending_execution`; lo resuelve el reconciler de SP13. `ExchangeError`/`InvalidOrder`
  (config/precisión/saldo) → `pending_execution` + alerta.
- **`placeOco`**: el retry SÍ es seguro (aún no hay OCO confirmado; un intento que dejó un OCO parcial
  hace que el siguiente choque con saldo y se detecte). Pocos reintentos con backoff; agotados →
  cierre de emergencia.
- **`emergencyClose` falla**: `positions.protected=false` (durable) + audit `emergency_close_failed` +
  alerta máxima + re-lanza.
- **Notify**: best-effort vía `notifyBestEffort`; un fallo de WhatsApp nunca tumba ni revierte una
  ejecución real.

## Persistencia: `parent_id` vs `orderListId` (L2)

Las legs OCO conservan `parent_id = <id de la entry order>` (consistente con `executeOrderSim` y el
esquema implementado), **no** `orderListId` — se corrige conscientemente el texto de §18.3 (que predata
la implementación). Cada leg guarda su `exchange_order_id` individual. El `orderListId` (id del grupo
OCO, necesario para cancelarlo en SP14) se registra en el payload del audit `order_filled_real`; si el
plan determina que SP14 lo necesita queryable, se añade una columna `orders.oco_list_id` (decisión del
plan, no bloqueante de SP12).

## Testing

- **Unit (Vitest, exchange mockeado/inyectado, 80%+):**
  - `setup-lock`: adquiere/libera; segundo intento (otro signalId, mismo setup) → `not_acquired`;
    release sólo del dueño (token); expira por TTL; **fail-closed** si el cliente Redis lanza.
  - `precision`: `roundAmount` baja a stepSize; `meetsMinNotional`; `netSellableQty` resta fee base y
    redondea (caso fee en BNB → fee base 0 → qty completa; caso fee en BTC → qty − feeBase).
  - `place-entry`: `capPrice` correcto; precisión aplicada; `below_min`; fill full/parcial/`zero_fill`;
    error → propaga incertidumbre; normalización de `avgPrice`/`fee`/`feeBase`/`exchangeOrderId`.
  - `place-oco`: SL con `stopPrice`+`limitPrice` (offset) y TP a `tp`; éxito devuelve ids;
    `NetworkError` reintenta N y cede; `ExchangeError` no reintenta; agotado lanza.
  - `emergency-close`: aplana qty neta; normaliza fills del cierre.
  - `execute-order-real`: máquina de estados completa con exchange inyectado — los 6 status; orden
    claim→exchange (la entrada nunca se llama si lock/claim no se obtuvo); **23505 en `openPosition` →
    emergencyClose** (carrera de setup); fallo-OCO→emergencia; `emergency_close_failed` deja
    `protected=false` y re-lanza; `protected` pasa a `true` **sólo** tras OCO; idempotencia (2º job
    mismo signalId → `duplicate`; 2ª señal mismo setup → `deduped`).
  - `evaluate-candidate`: despacho por modo (sim intacto; testnet llama `executeOrderReal`);
    kill-switch y dedup siguen **antes** del dinero.
- **Integración (Postgres del compose):** migración `protected`; persistencia real de
  orders/fills/positions/legs con `exchange_order_id`; `protected` false→true en el camino feliz y
  false persistente en `emergency_close_failed`; aislamiento por `mode='testnet'`; `executeOrderReal`
  con fake-exchange en memoria escribe filas correctas.
- **Sin red en CI:** ningún test toca testnet; el exchange siempre se inyecta/mockea.
- **Smoke vivo owner-gated (post-merge, VIGILADO):** `KAIROS_MODE=testnet`, **una** señal real, owner
  mirando → en Binance testnet la entrada llenó y el **OCO quedó residente** (open orders); en DB
  `positions.protected=true`, `orders` con `exchange_order_id`. El loop continuo desatendido **NO** se
  habilita hasta SP13.

## Riesgos y verificaciones para el plan

1. **Llamada OCO real de ccxt para Binance spot (la mayor incógnita)** — verificar contra la doc/código
   real de ccxt: firma exacta (¿`createOrderWithTakeProfitAndStopLoss` vs endpoint OCO de Binance
   `private_post_orderList_oco`/`order/oco` vía `params`?), parámetros de las dos legs (trigger vs
   límite, `LIMIT_MAKER` para TP), qué devuelve (`orderListId`, ids de legs), y **que el spot testnet
   soporta OCO**. Regla del proyecto: verificar ccxt contra su doc real, no de memoria. Si el OCO
   atómico no está disponible/soportado, fallback del plan: dos órdenes separadas (STOP_LOSS_LIMIT +
   LIMIT) con el monitor de SP13 como cancelador del leg restante — pero eso degradaría la atomicidad,
   así que confirmar OCO nativo primero.
2. **`fee` y moneda del fee** — `netSellableQty` depende de detectar si la fee se cobró en base (BTC),
   quote (USDT) o BNB. Confirmar la forma de `order.fee`/`order.fees` en ccxt-binance y, si hace falta,
   reconciliar contra `fetchBalance` el saldo base libre antes del OCO.
3. **Precisión exacta** — usar `exchange.amountToPrecision`/`priceToPrecision` y los límites del market
   (`market.limits.amount.min`, `market.limits.cost.min`, `precision`); confirmar nombres de campos en
   ccxt-binance.
4. **`live` comparte camino con `testnet`** — `executeOrderReal` sirve a ambos; sandbox por
   `KAIROS_MODE != live` en `ccxt-client`. Ningún guard nuevo de `live` en SP12 (Fase 4 endurece).
