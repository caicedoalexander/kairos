# Trailing stop determinista — cierre de Fase 3 (testnet)

> **Fecha:** 2026-06-30 · **Fase:** 3 (testnet), último sprint · **Predecesores:** SP12 (ejecutor real +
> `placeOco` + OCO residente), SP13 (monitor real `runMonitorTickReal` + reconciler A.2 + `getBracketLegs`),
> SP14 (`cancelOco` + cierre real cancel-first). Cierra la Fase 3 testnet.
>
> **v2:** incorpora los fixes del design-review (H1 precio fresco + persistir-después; H2 cancelar todos
> los ids + legs en sitio; H3 no bajar `protected` en trailing normal + fallback; M1 re-check por id con
> `protected`; M2 tipo del cliente; M3 bounds del schema).

## Principio rector (sin cambios)

El SL/TP duro es **determinista e inmediato** (server-side, OCO residente). El trailing de este sprint es
**determinista por regla** — el código mueve el SL hacia arriba según una regla configurada, sin LLM.
ARCHITECTURE §18/§19 contempla que el LLM participe en mover el SL como señal **opcional**; eso se difiere
(el LLM sigue en sombra). Ninguna tool de mutación entra al `tools:[]` de un agente.

## Objetivo

Subir el SL de una posición protegida a medida que el precio avanza a favor, recolocando el OCO residente
server-side con un SL mejor. Determinista, idempotente, crash-safe, **opt-in por estrategia**. Cierra el
plumbing de testnet de la Fase 3.

## Decisiones de diseño

- **Trailing determinista por regla** (NO LLM). El trailing con señal LLM → Fase 4+.
- **Regla `%` bajo el precio** (`distance_pct`), configurable por estrategia. (`k·ATR` se añade después.)
- **Dentro del monitor real** (`runMonitorTickReal`, SP13), que ya recorre cada posición protegida por
  REST cada `MONITOR_INTERVAL_MS`. El cierre por fill tiene **prioridad** sobre el trailing.
- **Opt-in por estrategia** vía `risk_params.trailing` (jsonb). Ausente/`enabled:false` → sin trailing.
- **Precio FRESCO vía `fetchTicker`** (FIX H1): el cancel-replace retira protección viva, así que la
  decisión usa el precio **vivo** (REST autoritativo §15.1), no la última vela cerrada (que puede tener
  ~1 vela + `OHLCV_REFRESH_INTERVAL_MS` de antigüedad → SL candidato inválido → rechazo de Binance).
- **SL nunca BAJA** (línea roja): el ratchet solo devuelve un SL > el vigente por `min_step`.

## Alcance

### Dentro de este sprint

1. **Schema de config** (`src/lib/monitor/trailing-config.ts`): `TrailingConfigSchema` (Valibot, **con
   bounds** — FIX M3) + `parseTrailingConfig(riskParams): TrailingConfig | null`.
2. **Regla pura** (`src/lib/monitor/trailing.ts`): `computeTrailingSl(args): number | null`.
3. **Mutación** (mismo `trailing.ts`): `applyTrailingStop(deps, position, newSl)` — cancel-first →
   `placeOco(newSl)` → (éxito) persiste SL + actualiza legs en sitio; (fallo) fallback `placeOco(oldSl)`.
4. **Lecturas/escrituras de repo:** `setPositionSl(id, sl, exec?)` y `getOpenPositionById(id)` (incluye
   `protected` — FIX M1) en `positions.ts`.
5. **Endurecer `cancelOco`** (FIX H2, `src/lib/execution/real-order/cancel-oco.ts`): cancelar **todos** los
   `exchangeOrderId` no-nulos distintos (no solo el primero), `OrderNotFound`=éxito por cada uno.
6. **Endurecer el reprotect de A.2** (FIX H2, `src/lib/reconcile/exchange-reconcile.ts`): cuando la posición
   ya tiene legs persistidas, **actualizar sus `exchange_order_id` en sitio** (`setOrderExchangeId`) en vez
   de insertar legs nuevas → siempre 2 filas de leg por decisión (evita las 4 filas divergentes).
7. **Integración en el monitor** (`src/lib/monitor/monitor-real.ts`): en `checkOne`, con el OCO vivo,
   evalúa el trailing. Ensanchar `MonitorRealDeps.client` con `CancelOcoClient` + `fetchTicker` (FIX M2).
8. **Config:** cargar la estrategia por posición (cacheable — FIX L2) para `risk_params.trailing`.

### Fuera de este sprint (diferido)

- **Trailing con señal LLM** (Fase 4+). **`k·ATR`** como forma de distancia. **Trailing del TP** (no se toca
  el TP; solo el SL sube). **Fase 4** (live).

## Arquitectura

El trailing extiende `runMonitorTickReal` sin cambiar su contrato. `checkOne` hoy: (1) si una leg llenó →
cierra (close-first, **prioridad**); si todas terminales → handoff; (2) si el OCO sigue vivo → retorna
`false`. El trailing se inserta en el paso (2): con el OCO vivo, evalúa subir el SL **antes** de retornar.

### Regla pura · `computeTrailingSl` (precio FRESCO)

```
computeTrailingSl({ entry, currentSl, price, cfg }): number | null
  // `price` = precio VIVO de fetchTicker (FIX H1), no la última vela cerrada
  if price <= entry * (1 + cfg.activation_pct): return null          // aún no activa (no en ganancia umbral)
  candidate = price * (1 - cfg.distance_pct)                          // SL candidato bajo el precio vivo
  if candidate >= price: return null                                 // sanity (con cfg válido no ocurre)
  if candidate <= currentSl * (1 + cfg.min_step_pct): return null    // no supera el SL vigente por min_step → NUNCA baja + anti-churn
  return candidate
```

- **Ratchet (línea roja):** pasar el último gate con `min_step_pct ≥ 0` y `currentSl > 0` **implica**
  `candidate > currentSl` → el SL solo sube. El borde `==` cae en `<=` → null (conservador).
- **Activación:** evita mover el SL antes de estar en ganancia umbral.

### `TrailingConfigSchema` (FIX M3 — bounds obligatorios)

```
v.object({
  enabled:        v.boolean(),
  activation_pct: v.pipe(v.number(), v.finite(), v.minValue(0)),
  distance_pct:   v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(0.5)),  // 0 < d ≤ 0.5
  min_step_pct:   v.pipe(v.number(), v.finite(), v.minValue(0)),
})
```
`parseTrailingConfig` devuelve `null` si `risk_params.trailing` está ausente, no parsea, o `enabled=false`.
Un `distance_pct ≤ 0` o `min_step_pct < 0` (misconfig) hace fallar el parse → trailing off (fail-safe).

### Mutación · `applyTrailingStop` (bajo `withSetupLock`) — FIX H1/H2/H3

```
withSetupLock(strategyId, symbol, mode):
  pos = getOpenPositionById(positionId)              // FIX M1: re-check por ID, incluye `protected`
  if !pos or pos.status != 'open' or !pos.protected: return    // carrera con cierre/handoff → abortar
  if newSl <= pos.sl: return                          // perdió la carrera (otro tick ya movió)
  legs = getBracketLegs(pos.decisionId)               // 2 filas (tras FIX H2 nunca hay duplicados)

  try { cancelOco(client, symbol, legs) }             // FIX H2: cancela TODOS los ids; OrderNotFound=éxito c/u
  catch { audit 'trailing_cancel_failed'; return }    // red: OCO viejo sigue vivo → sin daño, NO tocar protected

  // protected SIGUE = true durante el trailing normal (FIX H3): un crash en la ventana deja legs muertas
  // que el monitor detecta (handoff M3) en ≤ MONITOR_INTERVAL_MS. NO se baja protected salvo doble-fallo.
  let oco
  try { oco = placeOco(client, {symbol, qty: pos.size, sl: newSl, tp: pos.tp}) }
  catch {
    // FIX H1/H3: el SL nuevo pudo ser inválido (precio movió) o error transitorio → restaurar el OCO VIEJO
    try {
      oco = placeOco(client, {symbol, qty: pos.size, sl: pos.sl, tp: pos.tp})   // re-protege al SL VIEJO (válido)
      updateLegsInPlace(legs, oco); audit 'trailing_restore_oldsl'; return       // sl SIN cambiar, protected sigue true
    } catch {
      await setPositionProtected(pos.id, false); audit 'trailing_replace_failed'; return   // doble-fallo → reconciler A.2 al SL VIEJO
    }
  }
  // éxito al SL nuevo:
  await setPositionSl(pos.id, newSl)                  // FIX H1: persistir DESPUÉS del placeOco exitoso (nunca propaga candidato inválido a A.2)
  await updateLegsInPlace(legs, oco)                  // FIX H2: setOrderExchangeId sobre las 2 filas existentes (sl→slOrderId, tp→tpOrderId)
  audit 'trailing_sl_moved' { from: pos.sl, to: newSl }; notify best-effort "🔧 {symbol}: SL → {newSl}"
```

`updateLegsInPlace(legs, oco)`: para la leg `purpose='sl'` → `setOrderExchangeId(leg.id, oco.slOrderId)`;
para `purpose='tp'` → `setOrderExchangeId(leg.id, oco.tpOrderId)`. (Tras FIX H2 hay exactamente 2 filas.)

> **Persistir `sl` DESPUÉS del placeOco exitoso (FIX H1):** si el `placeOco(newSl)` se rechaza (candidato
> inválido por precio que se movió, o error), `positions.sl` queda en el valor VIEJO (válido) → ni el
> fallback ni el reconciler A.2 colocan un stop inválido ni disparan una venta de emergencia prematura. El
> avance del trailing solo se persiste cuando el OCO nuevo ya está colocado.

> **`protected` NO baja en el trailing normal (FIX H3):** mantenerlo `true` hace que un crash en la ventana
> cancel→place sea detectado por el **monitor** (legs muertas → handoff M3 → `protected=false` → A.2) en
> ≤ `MONITOR_INTERVAL_MS`, en vez de quedar invisible al monitor y esperar a A.2 (`RECONCILE_INTERVAL_MS`).
> Solo el **doble-fallo** (newSl y oldSl fallan) baja `protected=false` → A.2 re-protege al SL VIEJO.

### Residual declarado (honesto — FIX H3)

- **Ventana sin OCO** entre `cancelOco` y `placeOco` (2 llamadas REST). Inherente a recolocar un OCO
  residente (Binance no edita un OCO; cancela+recrea). En el caso normal el `placeOco` re-coloca de
  inmediato; el **crash** en la ventana deja `protected=true` con legs muertas → el monitor lo detecta en
  ≤ `MONITOR_INTERVAL_MS` (handoff) y A.2 re-protege en ≤ `RECONCILE_INTERVAL_MS` (al SL VIEJO, persistido).
  Peor caso sin stop ≈ `MONITOR_INTERVAL_MS + RECONCILE_INTERVAL_MS`. Misma clase que el gap de OCO de SP12;
  aceptable en testnet (play money).
- **Carrera A.2-vs-`protected=false`** (heredada de SP14, ahora rara porque el trailing normal NO baja
  `protected`): solo en el doble-fallo. A.2 no toma el lock, pero re-protege al **mismo** `pos.sl` (viejo,
  ya que no se persistió el nuevo) y el balance de Binance serializa/rechaza un segundo OCO → sin oversell.
  Acotado y declarado. Antes de live se endurece junto con T6-b de SP13.

## Datos / esquema

Sin columnas nuevas. SL en `positions.sl`. Config en `risk_params.trailing` (jsonb, opt-in). Nuevas:
- `setPositionSl(id, sl, exec?)` — `UPDATE kairos.positions SET sl = $2 WHERE id = $1`.
- `getOpenPositionById(id, exec?)` — devuelve `ReconcilePosition & { protected: boolean }` o `null`
  (status='open'); el SELECT añade `protected` (FIX M1).

Reusa: `setOrderExchangeId`/`getBracketLegs` (SP12/13), `setPositionProtected` (SP13), `cancelOco`
(SP14, endurecido), `placeOco` (SP12), `getStrategy` (risk_params), `withSetupLock` (SP12).

**Forma de `risk_params.trailing`** (opt-in; ejemplo):
```json
{ "trailing": { "enabled": true, "activation_pct": 0.01, "distance_pct": 0.015, "min_step_pct": 0.003 } }
```

## Manejo de errores

- **ccxt:** `cancelOco`/`placeOco` reusan el patrón SP12/SP14 (NetworkError → retry con backoff dentro de
  `placeOco`; ExchangeError → no-retry). `cancelOco` falla → abortar SIN tocar `protected` (OCO viejo vive).
  `placeOco(newSl)` falla → **fallback** `placeOco(oldSl)`; doble-fallo → `protected=false` → A.2.
- **Best-effort por posición:** el trailing corre dentro del loop best-effort de `runMonitorTickReal`; un
  fallo audita y el tick sigue. El trailing **nunca** bloquea el cierre por fill (evaluado primero).
- **Precio ausente** (`fetchTicker` falla/sin `last`): skip trailing esta vuelta (sin precio no se decide).
- **notify best-effort** (no propaga).

## Líneas rojas de seguridad (verificar en el review)

- Ninguna tool de mutación en `tools:[]` de un agente. El trailing es código del monitor; sin LLM.
- **SL nunca BAJA:** `computeTrailingSl` solo devuelve > el SL vigente (por `min_step`); el schema fuerza
  `min_step_pct ≥ 0` y `distance_pct ∈ (0, 0.5]`. El review verifica el ratchet y los bounds.
- Credenciales del exchange en closure (el cliente del monitor se inyecta; el modelo no lo ve).
- Idempotencia: bajo `withSetupLock` + re-check por id; `newSl <= pos.sl → skip`; `setPositionSl` es UPDATE.
- Nada toca dinero real sin el flag: solo `testnet|live` (el monitor sim sigue barra-a-barra). El trailing
  **reduce** riesgo (sube el SL), jamás abre ni baja el SL.
- Crash-safe: persistir el SL **después** del placeOco exitoso + `protected` se mantiene `true` → el monitor
  cubre el crash; el doble-fallo cae a A.2 al SL viejo.

## Verificación

- **Unit puro** `computeTrailingSl`: no activa bajo el umbral; sube cuando candidato > SL+min_step; NO baja
  (candidato < SL → null); NO se mueve por micro-paso; candidato < precio.
- **Unit** `parseTrailingConfig`: null si ausente/disabled/inválida (incl. `distance_pct ≤ 0`,
  `min_step_pct < 0`, no finito); parsea una config válida.
- **Unit** `applyTrailingStop` (mock ccxt + repos): happy (cancelOco→placeOco(newSl)→setPositionSl→
  updateLegsInPlace; **verifica el ORDEN: setPositionSl DESPUÉS de placeOco**; `protected` no se baja);
  `placeOco(newSl)` falla → **fallback** `placeOco(oldSl)` (sl sin cambiar, protected true); doble-fallo →
  `protected=false`; `cancelOco` falla → aborta sin tocar protected.
- **Unit** `cancelOco` endurecido: cancela TODOS los ids distintos (incl. caso 4 legs: cancela los vivos,
  OrderNotFound en los viejos = éxito).
- **Unit** A.2 reprotect: actualiza las 2 legs en sitio (no inserta duplicados) cuando ya existen legs.
- **Unit** integración en `runMonitorTickReal`: con OCO vivo + estrategia opt-in → evalúa trailing; sin
  trailing en la estrategia → no; el cierre por fill tiene prioridad (leg llena → NO trailing).
- **Integración** (Postgres): `setPositionSl` + `getOpenPositionById` (incluye `protected`).
- **Smoke vigilado owner-gated** (fuera de CI): en testnet, una posición en ganancia mueve el SL — el OCO
  viejo desaparece del exchange y aparece uno nuevo con SL más alto; `positions.sl` actualizado; sin doble
  OCO; sin venta de emergencia.
- **Cobertura 80%.** Córrelo de verdad antes de afirmar verde.

## Resultado

Cierra la **Fase 3 (testnet)** en código: el bot mueve el SL de forma determinista, crash-safe y opt-in
para dejar correr la ganancia con un stop cada vez más alto. El SL solo sube. El LLM sigue en sombra.
Pendiente tras este sprint: los **smokes vigilados owner-gated** (SP13, SP14, trailing) antes de habilitar
el **loop testnet continuo desatendido**; luego **Fase 4** (live, poco capital).
