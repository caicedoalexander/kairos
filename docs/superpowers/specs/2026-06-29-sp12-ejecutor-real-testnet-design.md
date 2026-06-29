# SP12 — Camino del dinero real en testnet (entrada + OCO residente)

> **Fase 3 (Testnet) — primer sub-proyecto.** Decompone Fase 3 en SP12 (este, entrada real + OCO),
> SP13 (salida real + reconciliación con ccxt + ohlcv al día) y SP14 (control que toca dinero:
> `/cierra`, `/modo`). SP12 es **autocontenido y seguro**: abre una posición real en Binance testnet
> y la deja protegida server-side, o no deja nada vivo sin protección.
>
> Fecha: 2026-06-29. Construye sobre Fase 1 (loop determinista sim cerrado) y Fase 2 (razonamiento LLM
> en sombra, completa). Claves de Binance testnet ya validadas (`fetchBalance` OK, sandbox por
> `KAIROS_MODE != live`).

## Principio rector (no negociable)

**El LLM tiene juicio, no gatillo.** SP12 NO cambia esto. En testnet el camino del dinero sigue
ejecutando el **veredicto determinista** (`buildDeterministicVerdict`); el LLM corre en sombra
(`shadow_verdicts`) igual que en Fase 2. Todo lo que toca el exchange es código determinista,
idempotente y auditable. Ninguna tool de mutación entra al `tools:[]` de un agente.

## Objetivo

Que `KAIROS_MODE=testnet` coloque **órdenes reales** en Binance Spot testnet por cada señal que hoy
ejecutaría en sim, con la misma idempotencia y auditoría, y que **ninguna posición real quede
desprotegida**: la entrada llena y, acto seguido, queda un **OCO residente (SL+TP) server-side**; si
el OCO no se puede colocar tras un fill real, un **cierre de emergencia** aplana la posición.

## Alcance

### Dentro de SP12

1. **Despacho por modo** en `evaluateCandidate`: `sim → executeOrderSim` (sin cambios);
   `testnet|live → executeOrderReal`.
2. **Lock Redis por candidato** (`withCandidateLock`) — claim **antes** de tocar el exchange (§821).
3. **Ejecutor real** (`executeOrderReal`): entrada *limit marketable IOC capada* → fills reales →
   abre posición desde fills reales → **OCO residente** → persistencia (`exchange_order_id`,
   `orderListId`) → audit.
4. **Fallo de OCO tras fill real** → retry breve → **cierre de emergencia** (market IOC).
5. **Singleton ccxt autenticado** (evita conflictos de nonce).
6. **Nuevos estados de ejecución**: `zero_fill`, `emergency_closed`.

### Fuera de SP12 (diferido, consciente)

- **SP13**: monitor que detecta cierres reales vía ccxt + P&L desde fills reales + trailing
  (recolocar el OCO al avanzar el precio); reconciler de arranque con `fetch` ccxt (diff DB↔exchange);
  mantener `kairos.ohlcv_candles` al día (cadencia de backfill).
- **SP14**: `/cierra <symbol>` (close_position idempotente real) y `/modo <sim|testnet|live>`.

> **Nota de secuenciación.** SP12 no depende de SP13: la seguridad de "nunca desprotegido" se logra
> dentro del ejecutor (OCO residente o cierre de emergencia). El monitor-red de SP13 hará *raro* el
> cierre de emergencia, pero no es prerrequisito para que SP12 sea seguro.

## Arquitectura

`executeOrderReal` es el hermano determinista de `executeOrderSim`. Comparte contrato
(`ExecuteOrderSimParams`-compatible, devuelve `ExecutionResult`) pero sustituye el `simulateFill`
paramétrico por llamadas ccxt reales y añade la colocación del OCO server-side. La diferencia
estructural con sim: en sim **una transacción DB** abarca todo (la entrada se "llena" sintéticamente
dentro de la tx); en real la entrada y el OCO son **llamadas al exchange fuera de cualquier
transacción DB**, así que la persistencia se hace en pasos discretos y la atomicidad se sustituye por
una **máquina de estados con compensación** (cierre de emergencia).

### Orden invariante: claim → exchange (§821)

```
withCandidateLock(signalId)            ← mutua exclusión rápida (Redis SET NX PX)
  └─ claimEntryOrder (INSERT ON CONFLICT)   ← idempotencia DURABLE (UNIQUE idempotency_key)
       └─ placeEntry (ccxt)            ← PRIMERA llamada al exchange
```

El lock Redis y el `INSERT` ocurren antes de cualquier llamada al exchange. Un reintento de BullMQ
(job stalled) re-entra: o no adquiere el lock, o choca con el `UNIQUE` → `duplicate`. Nunca duplica
una orden real. El lock es mutua exclusión *rápida* (evita siquiera intentar la doble llamada); la
idempotencia *durable* sigue siendo el `UNIQUE` en DB (sobrevive a un Redis caído/evictado).

## Componentes (archivos)

| Archivo | Acción | Responsabilidad |
|---------|--------|-----------------|
| `src/lib/execution/candidate-lock.ts` | crear | `withCandidateLock(signalId, fn)`: `SET key token NX PX ttl` sobre `REDIS_URL`; ejecuta `fn`; release en `finally` sólo si el token sigue siendo mío (check-and-del por script Lua o GET+DEL condicional). Si no adquiere → devuelve sentinela `not_acquired`. |
| `src/lib/ccxt-client.ts` | modificar | `getAuthenticatedClient()` **singleton** (una instancia por proceso) con `loadMarkets()` perezoso. Mantener `createAuthenticatedClient` como factory interno. |
| `src/lib/execution/real-order/place-entry.ts` | crear | `placeEntry(client, args)`: `capPrice = refPrice·(1+slippageBps/1e4)`; `createOrder(symbol,'limit','buy',size,capPrice,{timeInForce:'IOC'})`; normaliza a `{filledQty, avgPrice, fee, exchangeOrderId, raw}`. |
| `src/lib/execution/real-order/place-oco.ts` | crear | `placeOco(client, args)`: coloca el OCO de venta (SL_limit + TP_limit) por `qty`, con **retry breve** (NetworkError → backoff; ExchangeError → no-retry). Devuelve `{orderListId, slOrderId, tpOrderId}` o lanza tras agotar. |
| `src/lib/execution/real-order/emergency-close.ts` | crear | `emergencyClose(client, args)`: `createMarketSellOrder(symbol, qty)` IOC; normaliza fills del cierre `{exitPrice, exitFee, exchangeOrderId}`. |
| `src/lib/execution/execute-order-real.ts` | crear | Orquesta la máquina de estados completa (ver Flujo). Dependencias inyectables (`client`, `placeEntry`, `placeOco`, `emergencyClose`) para test. |
| `src/db/repositories/orders.ts` | modificar | `claimEntryOrder`/`insertBracketLeg` aceptan `exchangeOrderId?`; nuevo `setOrderExchangeId(id, exchangeOrderId, exec)`. |
| `src/orchestration/evaluate-candidate.ts` | modificar | Despacho por modo; ramas de notificación para `zero_fill`/`emergency_closed`. |
| `src/lib/execution/types.ts` | modificar | `ExecutionResult.status` suma `'zero_fill' \| 'emergency_closed'`. |

**Reúso sin cambio de firma:** `insertFill`, `openPosition`, `closePositionOnBracket`/`closePosition`,
`appendAuditLog`, `notifyBestEffort`, `getOrderByIdempotencyKey`, `updateOrderStatus`.

## Flujo de datos — `executeOrderReal`

```
1. withCandidateLock(signalId, async () => {
2.    claim = claimEntryOrder(idem=signalId, …)
        si not_acquired (lock) o !claim (UNIQUE) → return { status:'duplicate' }
3.    entry = placeEntry(client, {symbol, size, refPrice, slippageBps})        ← EXCHANGE
        NetworkError/ExchangeError → updateOrderStatus(claim.id,'pending_execution')
                                     audit 'entry_uncertain' → return {status:'pending_execution'}
        entry.filledQty === 0 → updateOrderStatus(claim.id,'canceled')
                                     audit 'entry_zero_fill' → return {status:'zero_fill'}
4.    // entry llenó (full/parcial)
        insertFill(claim.id, entry.avgPrice, entry.filledQty, entry.fee)
        positionId = openPosition({entry:entry.avgPrice, size:entry.filledQty, sl, tp,
                                   entryFee:entry.fee, …})
        updateOrderStatus(claim.id,'filled'); setOrderExchangeId(claim.id, entry.exchangeOrderId)
5.    try {
        oco = placeOco(client, {symbol, qty:entry.filledQty, sl, tp})           ← EXCHANGE (retry)
        insertBracketLeg(sl, exchangeOrderId=oco.slOrderId); insertBracketLeg(tp, oco.tpOrderId)
        audit 'order_filled_real' → return {status:'filled', positionId, fillPrice, qty, fee}
      } catch {
        exit = emergencyClose(client, {symbol, qty:entry.filledQty})           ← EXCHANGE
        insertFill(cierre); closePosition(positionId, exit); audit 'oco_failed_emergency_closed'
        return {status:'emergency_closed', positionId, …}
        // si emergencyClose TAMBIÉN falla: audit 'emergency_close_failed' + alerta MÁXIMA;
        //   re-lanza para que el job quede failed y un humano/monitor-red (SP13) intervenga.
      }
   })
```

**Parámetros de entrada:** `refPrice = verdict.entry` (igual que sim hoy); `slippageBps =
DEFAULT_SIM_PARAMS.slippage_bps` (= 5, reúso — sim y testnet comparten el supuesto de slippage del
cap); `size = riskResult.adjustedSize`.

**Fill parcial:** si el IOC llena parcial, posición y OCO se abren por `filledQty` real (el remanente
IOC ya se canceló solo en el exchange). No se persigue.

## Estados y notificación

| Status | Significado | Posición | Notify (best-effort) | Audit |
|--------|-------------|----------|----------------------|-------|
| `filled` | Entrada llenó + OCO residente | abierta, protegida server-side | `✅ {symbol}: entrada @ {price} ({qty}) sl={sl} tp={tp} (OCO residente)` | `order_filled_real` |
| `zero_fill` | IOC capado no cruzó | no se abre | `➖ {symbol}: entrada no cruzó (IOC capado), sin posición` | `entry_zero_fill` |
| `emergency_closed` | OCO falló tras retries → aplanada | abierta→cerrada | `🚨 {symbol}: OCO falló — posición aplanada por emergencia` | `oco_failed_emergency_closed` |
| `pending_execution` | Entrada incierta (timeout/red/ExchangeError) | no se asume | `⏳ {symbol}: ejecución pendiente (no asumida). idem={idem}` | `entry_uncertain` |
| `duplicate` | Lock o UNIQUE tomado (reintento) | — | — (silencioso) | — |

## Manejo de errores (clasificación ccxt)

- **Reintentable**: `NetworkError`, `RequestTimeout`, `RateLimitExceeded`, `ExchangeNotAvailable`,
  `DDoSProtection`. **No reintentable**: `ExchangeError`, `AuthenticationError`, `InsufficientFunds`,
  `InvalidOrder`, `NotSupported`.
- **`placeEntry`**: NO reintenta ante `NetworkError` (la entrada es *incierta* — ¿llegó la orden?;
  reintentar ciegamente duplicaría). Cualquier error → `pending_execution`; lo resuelve el reconciler
  de SP13. `ExchangeError` (config/saldo) → `pending_execution` + alerta.
- **`placeOco`**: el retry SÍ es seguro (aún no hay OCO confirmado; un intento que dejó un OCO
  parcial hace que el siguiente choque con saldo y se detecte). Pocos reintentos con backoff;
  agotados → cierre de emergencia.
- **`emergencyClose` falla**: caso peor (posición real viva, sin protección, sin poder cerrar) →
  audit `emergency_close_failed` + **alerta máxima** + re-lanza (job `failed`). Único camino con
  exposición residual; riesgo aceptado de testnet (play money), retomado por el monitor-red de SP13.
- **Notify**: best-effort vía `notifyBestEffort`; un fallo de WhatsApp nunca tumba ni revierte una
  ejecución real.

## Testing

- **Unit (Vitest, exchange mockeado/inyectado, 80%+):**
  - `candidate-lock`: adquiere/libera; segundo intento concurrente → `not_acquired`; release sólo del
    dueño (token); expira por TTL.
  - `place-entry`: `capPrice` correcto; fill full / parcial / `zero_fill`; error → propaga
    incertidumbre; normalización de `avgPrice`/`fee`/`exchangeOrderId`.
  - `place-oco`: éxito devuelve ids; `NetworkError` reintenta N veces y luego cede; `ExchangeError`
    no reintenta (cede ya); agotado lanza.
  - `emergency-close`: aplana `qty`; normaliza fills del cierre.
  - `execute-order-real`: máquina de estados completa con exchange inyectado — los 5 status; orden
    claim→exchange (la entrada nunca se llama si el lock/claim no se obtuvo); fallo-OCO→emergencia;
    `emergency_close_failed` re-lanza; idempotencia (2º llamado → `duplicate`).
  - `evaluate-candidate`: despacho por modo (sim intacto; testnet llama `executeOrderReal`);
    kill-switch y dedup siguen **antes** del dinero.
- **Integración (Postgres del compose):** persistencia real de orders/fills/positions/legs con
  `exchange_order_id`/`orderListId`; aislamiento por `mode='testnet'`; el `executeOrderReal` con un
  fake-exchange en memoria escribe filas correctas.
- **Sin red en CI:** ningún test toca testnet; el exchange siempre se inyecta/mockea.
- **Smoke vivo owner-gated (post-merge):** `KAIROS_MODE=testnet`, una señal real → en Binance testnet
  la entrada llenó y el **OCO quedó residente** (visible en open orders); en DB `positions`/`orders`
  reflejan fills reales con `exchange_order_id`. Éste es el "¿funciona el plumbing?" de Fase 3.

## Riesgos y verificaciones para el plan

1. **Llamada OCO real de ccxt para Binance spot** — verificar contra la doc/código real de ccxt la
   firma exacta (`createOrderWithTakeProfitAndStopLoss` vs endpoint OCO de Binance vía `params`),
   qué devuelve (`orderListId`, ids de legs) y **que el spot testnet soporta OCO**. Es la mayor
   incógnita; tarea explícita de investigación en el plan (regla del proyecto: verificar ccxt contra
   su doc real, no de memoria).
2. **Precisión de precio/cantidad** — usar `exchange.priceToPrecision`/`amountToPrecision` y respetar
   `minNotional`/`stepSize` del market (`loadMarkets`) antes de enviar; un size por debajo del mínimo
   debe degradar limpio (no crashear).
3. **`fee` en moneda no-quote** — Binance puede cobrar fee en BNB; normalizar a quote o registrar la
   moneda del fee (consistencia con el modelo de P&L). Decidir en el plan.
4. **Lock con Redis caído** — si `REDIS_URL` está caído, `withCandidateLock` debe **fallar cerrado**
   (no ejecutar sin lock) o degradar a sólo-UNIQUE; decidir en el plan (preferencia: fallar cerrado
   en testnet, el `UNIQUE` es la red durable).
5. **`live` comparte camino con `testnet`** — `executeOrderReal` sirve a ambos; el sandbox lo decide
   `KAIROS_MODE != live` en `ccxt-client`. Ningún guard nuevo de `live` en SP12 (Fase 4 endurece).
