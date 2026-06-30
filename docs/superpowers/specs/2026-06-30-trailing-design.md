# Trailing stop determinista — cierre de Fase 3 (testnet)

> **Fecha:** 2026-06-30 · **Fase:** 3 (testnet), último sprint · **Predecesores:** SP12 (ejecutor real +
> `placeOco` + OCO residente), SP13 (monitor real `runMonitorTickReal` + reconciler A.2 + `getBracketLegs`),
> SP14 (`cancelOco` + cierre real cancel-first). Cierra la Fase 3 testnet.

## Principio rector (sin cambios)

El SL/TP duro es **determinista e inmediato** (server-side, OCO residente). El trailing de este sprint
es **determinista por regla** — el código mueve el SL hacia arriba según una regla configurada, sin LLM.
ARCHITECTURE §18/§19 contempla que el LLM participe en mover el SL como señal **opcional**; eso se
difiere (el LLM sigue en sombra). Ninguna tool de mutación entra al `tools:[]` de un agente: el trailing
es código del monitor que llama ccxt directamente.

## Objetivo

Subir el SL de una posición protegida a medida que el precio avanza a favor, para **asegurar ganancia**,
recolocando el OCO residente server-side con un SL mejor. Determinista, idempotente, crash-safe,
**opt-in por estrategia**. Cierra el plumbing de testnet de la Fase 3.

## Decisiones de diseño (tomadas en brainstorming)

- **Trailing determinista por regla** (NO LLM). El trailing con señal LLM es una mejora de la capa de
  razonamiento → Fase 4+. Conservador y alineado con "el SL es determinista".
- **Regla `%` bajo el precio** (`distance_pct`), configurable por estrategia. (Un `k·ATR` se puede añadir
  después como otra forma de `distance`; el MVP usa `%`, el más simple y sin dependencia del ATR vivo.)
- **Dentro del monitor real** (`runMonitorTickReal`, SP13), que ya recorre cada posición protegida por
  REST cada `MONITOR_INTERVAL_MS`. El trailing es una extensión natural: precio/estado ya disponibles.
- **Opt-in por estrategia** vía `risk_params.trailing` (jsonb). Ausente/`enabled:false` → sin trailing →
  las estrategias actuales no cambian de comportamiento (YAGNI/seguro).
- **Precio vía `getLatestClosePrice(symbol)`** (SP14, última vela cerrada — REST autoritativo §15.1; sin
  llamada ccxt extra).
- **SL nunca BAJA** (línea roja): solo se mueve si el SL candidato supera el SL vigente por `min_step`.

## Alcance

### Dentro de este sprint

1. **Schema de config de trailing** (`src/lib/monitor/trailing-config.ts`): `TrailingConfigSchema` (Valibot)
   que parsea `risk_params.trailing` → `{ enabled, activation_pct, distance_pct, min_step_pct }`;
   `parseTrailingConfig(riskParams): TrailingConfig | null` (null si ausente/inválida/disabled).
2. **Regla pura** (`src/lib/monitor/trailing.ts`): `computeTrailingSl(args): number | null` — devuelve el
   SL nuevo si procede subir, o null. Pura, testeable.
3. **Mutación** (mismo `trailing.ts`): `applyTrailingStop(deps, position, newSl)` — bajo `withSetupLock`:
   cancel-first → persiste SL → re-coloca OCO → actualiza ids de legs → `protected=true`. Crash-safe.
4. **Lectura de SL persistido** (`src/db/repositories/positions.ts`): `setPositionSl(id, sl, exec?)`.
5. **Integración en el monitor** (`src/lib/monitor/monitor-real.ts`): en `checkOne`, cuando el OCO sigue
   vivo (ninguna leg llenó, ninguna terminal), evalúa el trailing **antes** de retornar. No interfiere
   con el cierre por fill (que tiene prioridad).
6. **Config del worker:** el monitor real ya recibe `client`/`mode`/`notify`; el trailing necesita además
   el `strategyId→config`. Se resuelve cargando la estrategia por posición (cacheable).

### Fuera de este sprint (diferido, consciente)

- **Trailing con señal LLM** (el LLM propone mover el SL como señal de salida) — Fase 4+ (razonamiento).
- **`k·ATR` como forma de distancia** — extensión posterior de `distance` (el MVP usa `%`).
- **Trailing del TP** — no se toca el TP; solo el SL sube.
- **Fase 4** (live, poco capital).

## Arquitectura

El trailing extiende `runMonitorTickReal` sin cambiar su contrato. Hoy `checkOne(deps, p, asOf)`:
1. lee legs, fetch leg state; si una llenó → cierra (close-first, prioridad); si todas terminales → handoff.
2. si el OCO sigue vivo → retorna `false` (nada).

El trailing se inserta en el paso 2: **antes** de retornar `false` con el OCO vivo, evalúa subir el SL.

### Regla pura · `computeTrailingSl`

```
computeTrailingSl({ entry, currentSl, price, cfg }): number | null
  if price <= entry * (1 + cfg.activation_pct): return null        // aún no activa (no en ganancia umbral)
  candidate = price * (1 - cfg.distance_pct)                        // SL candidato bajo el precio
  if candidate <= currentSl + currentSl * cfg.min_step_pct: return null  // no supera el SL vigente por min_step (anti-churn + nunca baja)
  if candidate >= price: return null                               // sanity: el SL debe quedar bajo el precio
  return candidate
```

- **Activación:** evita mover el SL antes de estar en ganancia (un trailing desde el inicio podría dejar
  el SL sobre el entry demasiado pronto).
- **Ratchet + anti-churn:** `min_step_pct` exige un salto mínimo; combinado con `candidate > currentSl`,
  el SL **solo sube** y no se recoloca por micro-movimientos (cada recolocación son 2 llamadas REST + una
  ventana sin OCO).

### Mutación · `applyTrailingStop` (bajo `withSetupLock`)

```
withSetupLock(strategyId, symbol, mode):
  pos = getOpenPositionBySymbol(symbol, mode)        // re-check open (SP14)
  if !pos or !protected-equivalent: return           // carrera con un cierre → abortar
  newSl recomputado o el pasado; if newSl <= pos.sl: return   // perdió la carrera
  legs = getBracketLegs(pos.decisionId)
  try { cancelOco(client, symbol, legs) }            // cancel-first (SP14)
  catch { audit 'trailing_cancel_failed'; return }   // OCO viejo sigue vivo → sin daño, no tocar protected
  await setPositionSl(pos.id, newSl)                 // persiste el SL nuevo ANTES de re-colocar (crash-safe)
  await setPositionProtected(pos.id, false)          // momentáneamente desprotegida (crash → A.2 al SL nuevo)
  try { oco = placeOco(client, {symbol, qty: pos.size, sl: newSl, tp: pos.tp}) }   // SP12
  catch { audit 'trailing_replace_failed'; return }  // protected=false → reconciler A.2 re-protege al SL nuevo
  await setOrderExchangeId(slLegId, oco.slOrderId)   // actualiza los ids de las legs EN SITIO (no inserta nuevas)
  await setOrderExchangeId(tpLegId, oco.tpOrderId)
  await setPositionProtected(pos.id, true)
  audit 'trailing_sl_moved' { from: pos.sl, to: newSl }
  notify best-effort "🔧 {symbol}: SL movido a {newSl}"
```

> **Por qué persistir `sl` antes de `placeOco`:** si el proceso crashea (o `placeOco` falla) tras
> `cancelOco`, la posición queda `protected=false` con `positions.sl = newSl` → el reconciler A.2 de SP13
> la re-protege **al SL nuevo** (A.2 coloca el OCO con `pos.sl`/`pos.tp` de la fila). Sin esto, A.2
> re-protegería al SL viejo, perdiendo el avance del trailing.

> **Por qué actualizar los ids de las legs en sitio** (`setOrderExchangeId` sobre las 2 filas de leg
> existentes) y NO insertar legs nuevas: el monitor lee `getBracketLegs(decisionId)` por `decision_id`;
> mantener 2 filas (con los ids del OCO nuevo) evita acumular legs canceladas que confundan al polling.

### Residual declarado (ventana sin OCO)

Entre `cancelOco` y `placeOco` la posición queda **sin OCO** brevemente (2 llamadas REST). Es inherente a
recolocar un OCO residente (Binance no edita un OCO: cancela+recrea). Se acota con `min_step_pct` (no se
recoloca por cada tick) y la cubre el reconciler A.2 / el siguiente tick del monitor si algo falla en la
ventana. Misma clase de residual que el gap de colocación de OCO de SP12. Aceptable en testnet (play money).

## Datos / esquema

Sin columnas nuevas. El SL vive en `positions.sl` (ya existe). La config de trailing vive en
`risk_params.trailing` (jsonb existente; opt-in). Nueva escritura: `setPositionSl(id, sl, exec?)`
(`UPDATE kairos.positions SET sl = $2 WHERE id = $1`). Reusa `setOrderExchangeId` (SP12),
`getOpenPositionBySymbol` (SP14), `getBracketLegs`/`setPositionProtected` (SP13), `cancelOco` (SP14),
`placeOco` (SP12), `getLatestClosePrice` (SP14), `getStrategy` (para `risk_params`).

**Forma de `risk_params.trailing`** (opt-in; ejemplo):
```json
{ "trailing": { "enabled": true, "activation_pct": 0.01, "distance_pct": 0.015, "min_step_pct": 0.003 } }
```

## Manejo de errores

- **ccxt:** `cancelOco`/`placeOco` reusan el patrón de SP12/SP14 (NetworkError → retry con backoff dentro
  de `placeOco`; ExchangeError → no-retry). `cancelOco` falla → abortar SIN tocar `protected` (OCO viejo
  vive). `placeOco` falla tras cancelar → `protected=false` (ya seteado) → A.2 re-protege al SL nuevo.
- **Best-effort por posición:** el trailing corre dentro del loop best-effort de `runMonitorTickReal`; un
  fallo audita y el tick sigue con la siguiente posición. El trailing **nunca** bloquea el cierre por fill
  (que se evalúa primero en `checkOne`).
- **Precio ausente** (`getLatestClosePrice` → null): skip trailing esta vuelta (sin precio no se decide).
- **notify best-effort** (no propaga).

## Líneas rojas de seguridad (verificar en el review)

- Ninguna tool de mutación en `tools:[]` de un agente. El trailing es código del monitor; sin LLM.
- **SL nunca BAJA:** `computeTrailingSl` solo devuelve un SL > el vigente (por `min_step`). Un trailing que
  bajara el SL aumentaría el riesgo → prohibido. (El review debe verificar el ratchet.)
- Credenciales del exchange en closure (el cliente del monitor ya se inyecta; el modelo no lo ve).
- Idempotencia: bajo `withSetupLock` + re-check; `setPositionSl` es UPDATE simple; si dos ticks intentan
  trailing a la vez, el segundo no adquiere el lock o ve el SL ya movido (`newSl <= pos.sl` → skip).
- Nada toca dinero real sin el flag: solo `testnet|live` (el monitor sim sigue barra-a-barra, sin trailing
  real). El trailing **reduce** riesgo (sube el SL), jamás abre ni baja el SL.
- Crash-safe: persistir el SL antes de re-colocar + `protected=false` en la ventana → A.2 cubre el hueco.

## Verificación

- **Unit puro** `computeTrailingSl`: no activa bajo el umbral; sube cuando el candidato supera el SL+min_step;
  NO baja (candidato < SL → null); NO se mueve por micro-paso (< min_step → null); candidato siempre < precio.
- **Unit** `parseTrailingConfig`: null si ausente/disabled/inválida; parsea una config válida.
- **Unit** `applyTrailingStop` (mock ccxt + repos): happy (cancel→setSl→place→update ids→protected, audit
  'trailing_sl_moved'); `cancelOco` falla → aborta sin tocar protected; `placeOco` falla → `protected=false`
  (sin re-set a true), SL ya persistido. Verifica el ORDEN (setPositionSl antes de placeOco).
- **Unit** integración en `runMonitorTickReal`: con OCO vivo + estrategia opt-in → evalúa trailing; con
  estrategia sin trailing → no; el cierre por fill tiene prioridad (si una leg llenó, NO hace trailing).
- **Integración** (Postgres): `setPositionSl` + lectura.
- **Smoke vigilado owner-gated** (fuera de CI): en testnet, una posición en ganancia mueve el SL — verifica
  que el OCO viejo desaparece del exchange y aparece uno nuevo con SL más alto, y `positions.sl` actualizado.
- **Cobertura 80%.** Córrelo de verdad antes de afirmar verde.

## Resultado

Cierra la **Fase 3 (testnet)** en código: el bot asegura ganancia subiendo el SL de forma determinista,
crash-safe y opt-in. El LLM sigue en sombra. Pendiente tras este sprint: los **smokes vigilados
owner-gated** (SP13 reconciler/monitor, SP14 `/cierra`, y este trailing) antes de habilitar el **loop
testnet continuo desatendido**; luego **Fase 4** (live, poco capital).
