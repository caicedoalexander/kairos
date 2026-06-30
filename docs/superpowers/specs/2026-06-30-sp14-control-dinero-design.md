# SP14 — Comandos de control que tocan dinero: `/cierra` y `/modo` (Fase 3, testnet)

> **Fecha:** 2026-06-30 · **Fase:** 3 (testnet) · **Predecesores:** SP11 (canal de control WhatsApp
> inbound), SP12 (ejecutor real + `emergencyClose`), SP13 (reconciler/monitor ccxt, close-first).
> Completa los comandos de control que SP11 difirió a testnet.

## Principio rector (sin cambios)

El LLM tiene **juicio, no gatillo**. En SP14 esto se endurece para el comando que mueve dinero:
**`/cierra` es slash-only y determinista; el LLM nunca decide qué posición se cierra.** El clasificador
de control (`control-maker`, Haiku, `tools:[]`) solo clasifica comandos seguros y `/modo` (read-only);
una petición de cierre en texto libre se clasifica a `unknown` y se responde con ayuda. Mover dinero es
código determinista, idempotente y auditable. Ninguna tool de mutación entra al `tools:[]` de un agente.

## Objetivo

Habilitar dos comandos de control por WhatsApp inbound, diferidos de SP11:
1. **`/cierra <symbol>`** — cierre **real e idempotente** de una posición abierta (intervención manual
   del owner en testnet), por camino determinista con compensación.
2. **`/modo`** — **solo-lectura**: reporta el modo de operación actual.

## Decisiones de diseño (tomadas en brainstorming)

- **`/modo` solo-lectura.** Reporta `getMode()`; **NO** conmuta el modo en caliente. La conmutación en
  caliente se difiere a su propio sprint: exige migrar el modo de `process.env.KAIROS_MODE` (hoy
  `getMode()` es **síncrono** y se lee en muchísimos sitios, incluido `ccxt-client.setSandboxMode`) a un
  estado en DB leído async, con manejo de estado **distribuido** entre el proceso worker y el del webhook
  y una guarda "debe estar plano" — radio de impacto grande y riesgo alto (live mueve dinero). YAGNI +
  seguridad: conmutar sigue siendo un acto deliberado (reiniciar con `KAIROS_MODE=X`).
- **`/cierra` slash-only y determinista.** El LLM **no** rutea a cierre: el símbolo se parsea del slash
  y el código lo valida contra las posiciones abiertas.
  **FIX H1 (línea roja — mecanismo correcto):** lo que restringe al modelo NO es el `output` del
  `defineWorkflow` (valida solo el retorno de `run()`), sino el schema **`result`** que se pasa a
  `session.skill(...)` (`control-maker.ts:37`). Por eso SP14 define **DOS schemas**: **`ControlResultSchema`**
  (estricto, el que ve el LLM vía `result`): picklist `['estado','pausa','reanuda','modo','unknown']`
  **SIN `cierra` ni `symbol`** → el modelo es estructuralmente incapaz de emitir un cierre; y
  **`ControlIntentSchema`** (completo, con `cierra`+`symbol`): usado **solo** en el parser slash y en
  `dispatchControl`. El slash es el ÚNICO productor de `{command:'cierra'}`.
- **Cancel-first en el cierre real.** Cancelar el OCO residente **antes** de la venta de mercado evita
  (a) que el monitor cierre la posición por un fill del OCO en carrera y (b) que el OCO dispare durante
  la venta → anti doble-venta.
- **`/cierra` reduce exposición (no abre)** → riesgo intrínsecamente menor que el ejecutor; aun así pasa
  por código determinista, idempotente (`closeOpenPosition`) y serializado (`withSetupLock`).

## Alcance

### Dentro de SP14

1. **Dos esquemas de intención** (`control-intent-schema.ts`, FIX H1): `ControlIntentSchema` completo —
   picklist `['estado','pausa','reanuda','cierra','modo','unknown']` + `symbol: v.optional(v.string())`
   (solo lo puebla el parser slash) — para el slash y `dispatchControl`; y `ControlResultSchema` estricto
   — picklist `['estado','pausa','reanuda','modo','unknown']` **sin `cierra` ni `symbol`** — que es el
   que se pasa como `result` a `session.skill` en el `control-maker`.
2. **Parser slash** (`parse-control.ts`): `/cierra <symbol>` captura el símbolo (segunda palabra,
   normalizado); `/modo` mapea a `{command:'modo'}`. El resto sin cambios.
3. **Cierre real determinista** (módulo nuevo `src/lib/control/close-position-command.ts`): despacho por
   modo; `sim` cierra sintético, `testnet|live` cancela OCO → market sell → cierra. Lock-guarded.
4. **Despacho** (`dispatch-control.ts`): casos `cierra` (requiere símbolo; sin símbolo → ayuda) y `modo`
   (reporta el modo). `DispatchDeps` gana `closePosition(symbol)` y `currentMode`.
5. **Cancelación de OCO** (`src/lib/execution/real-order/cancel-oco.ts`): cancela la order-list residente
   de Binance vía ccxt (método verificado contra ccxt real en el plan).
6. **Cableado** (`evolution.ts`, `control-maker.ts`): extiende los tipos; el `control-maker` pasa
   `ControlResultSchema` (estricto) como `result` a `session.skill` y su `output` `v.object` usa el mismo
   picklist estricto; el skill `control-protocol` guía `/modo` (read-only) y mantiene cierre → `unknown`.
   Las deps del cierre real (cliente ccxt en closure) se construyen en el cableado.

### Fuera de SP14 (diferido, consciente)

- **Conmutación de modo en caliente** (`/modo <sim|testnet|live>` que escribe): sprint propio
  (migración modo env→DB, estado distribuido worker/webhook, guarda "plano", bloqueo de live).
- **Trailing** (recolocar OCO): sprint propio (cierra la Fase 3 junto con esto).
- **Fase 4** (live, poco capital).

## Arquitectura

SP14 extiende el canal de control de SP11 sin reescribirlo. El flujo inbound (webhook → firma →
`fromMe` → autoriza → audita → `processControlMessage`) queda intacto. `processControlMessage` ya rutea:
slash → `dispatchControl` determinista + reply; texto libre → `invoke(control-maker)` (LLM). SP14 añade
comandos a ambas ramas, con `cierra` **solo** en la rama slash.

### Puntos que hardcodean la lista de comandos (extender consistentemente)

1. `ControlIntentSchema` completo (picklist + `symbol`) — slash + dispatch; **`ControlResultSchema`**
   estricto (sin `cierra`/`symbol`) — el `result` del LLM (FIX H1).
2. `parseSlashCommand` (mapa SLASH + captura de argumento para `cierra`).
3. `dispatchControl` (switch).
4. Los tipos del comando en `evolution.ts` (`ControlRouteDeps.dispatch`, usa el schema completo porque la
   rama slash sí produce `cierra`) y, en `control-maker`, **el `result` de `session.skill` y el `output`
   del workflow usan el picklist ESTRICTO** (sin `cierra`) — el LLM no puede emitir un cierre.

### `/cierra <symbol>` — máquina de cierre con compensación (`close-position-command.ts`)

`closePositionCommand(symbol, deps): Promise<string>` (devuelve el texto de reply). Despacho por modo:

```
pos0 = getOpenPositionBySymbol(symbol, mode)   ← query DEDICADA (FIX M1: NO getOpenPositions, que
                                                  filtra sl/tp NOT NULL + trigger-TF). Si null:
                                                  "no hay posición abierta para {symbol}"
strategyId = pos0.strategyId                    ← FIX M2: el lock/dedup son por (strategyId,symbol,mode);
                                                  se resuelve ANTES del lock. (Supuesto testnet: una
                                                  posición abierta por símbolo; si hubiera >1 de
                                                  estrategias distintas, cierra la del re-check y avisa.)

modo testnet|live:
  withSetupLock(strategyId, symbol, mode):
    pos = getOpenPositionBySymbol(symbol, mode)   ← re-check dentro del lock
    if !pos: return "ya cerrada / sin posición"
    cancelOco(client, legs de pos)            ← cancela el OCO residente vía exchange_order_id de UNA leg
                                                (FIX M3; en Binance spot cancelar una leg cancela la lista)
    exit = emergencyClose(client, {symbol, qty: pos.size})   ← market sell IOC (reusa SP12)
    insertFill(exit) ; closeOpenPosition(pos.id, realized) ; closeBracketLegs
    audit 'position_closed_command' ; return "✅ {symbol} cerrada @ {exit} (pnl {realized})"
    // si emergencyClose lanza → rama de fallo (abajo, FIX H2)

modo sim:
  pos = getOpenPositionBySymbol(symbol, mode) ; cierra al último precio almacenado con sim fill (peor que mid)
  insertFill sintético ; closeOpenPosition ; closeBracketLegs ; return "✅ {symbol} cerrada (sim)"
```

- **Idempotencia:** `closeOpenPosition` solo cierra si `status='open'`; un `/cierra` repetido tras el
  cierre encuentra la posición ya cerrada en el re-check → noop ("ya cerrada"). El `withSetupLock`
  serializa vs el ejecutor y vs otro `/cierra` concurrente → no hay doble-venta.
- **P&L real:** `realized = (exit - entry) * size - exitFee - entryFee` (consistente con SP13; misma
  salvedad de moneda del fee — ver §Errores L1).
- **Cancel-first:** tras cancelar el OCO, las legs quedan canceladas → el monitor (SP13) no las verá
  llenas; hará handoff (`protected=false`) en vez de cerrar. La posición la cierra `/cierra`.
- **FIX H3 — sub-caso "OCO ya disparó ANTES de `/cierra`" (DB rezagada):** el re-check ve la posición
  abierta (lag DB), `cancelOco` halla las legs ya filled/canceled (`cancelOrder` lanza → se trata como
  éxito), y `emergencyClose` intenta vender base **que ya no existe** → `InsufficientFunds`
  (ExchangeError, sin retry) → rama de fallo. **`InsufficientFunds` es el backstop real** (el exchange
  rechaza la venta redundante; NO hay doble-venta de valor). El monitor close-first de SP13 cerrará luego
  la posición con el P&L real del OCO. El cancel-first cubre el fill *durante* la venta; este sub-caso lo
  cubre el rechazo del exchange.

### Modo de fallo declarado (no silenciar) — FIX H2

Si `emergencyClose` falla **tras** `cancelOco`: el OCO ya está cancelado en el exchange pero la fila DB
sigue `protected=true` (nada lo cambió). Para que el reconciler **la tome de inmediato** (A.2 solo escanea
`protected=false`, `findUnprotectedPositions`), la rama de fallo llama **explícitamente**
`setPositionProtected(positionId, false)` + audit `close_command_failed`, y el reply informa "cierre falló;
la posición pasará a reconciliación — reintenta". En el siguiente tick, el **reconciler A.2 de SP13**:
- **re-protege** (re-arma un OCO) **si la base sigue presente** (la venta falló por NetworkError, no se
  vendió); **o**
- **cierra con P&L real si la base ya se vendió** (p.ej. el OCO había disparado — A.2 detecta "cerrada en
  el exchange sin balance base").

Ambos desenlaces son correctos. **Falla cerrado:** nunca queda desprotegida indefinidamente (sin
`setPositionProtected(false)` dependería de la cadencia del monitor; con él, A.2 la toma directo) ni se
doble-vende (cancel-first + `InsufficientFunds` como backstop, FIX H3). Deuda consciente de testnet; el
owner puede reintentar `/cierra`.

> **Carrera con el reconciler A.2 (declarada, aceptable en testnet):** entre `setPositionProtected(false)`
> y un reintento, A.2 podría re-proteger una posición que el owner quiere cerrar (re-arma un OCO efímero
> que el siguiente `/cierra` vuelve a cancelar). `closeOpenPosition` (atómico, idempotente) y
> `withSetupLock` acotan el daño. En testnet (play money) es aceptable; se endurece antes de live junto
> con el riesgo T6-b de SP13.

### `/modo` — solo-lectura

`dispatchControl` caso `modo`: devuelve `Modo actual: {currentMode}. (conmutar requiere reiniciar con
KAIROS_MODE=…; la conmutación en caliente llega en un sprint propio).` Sin efecto secundario.

> **FIX L3:** `getMode()` (síncrono) lee el env del proceso que corre `processControlMessage` (la app
> Flue/webhook), que podría diferir del proceso worker si sus `.env` divergen. `/modo` informa el modo de
> la **app de control**; con un `.env` compartido (el caso normal) coincide con el del loop. Se menciona
> para no inducir a error.

## Manejo de errores

- **ccxt:** `cancelOco`/`emergencyClose` reutilizan el patrón de SP12 (NetworkError → retry con backoff;
  ExchangeError → no-retry). Un `cancelOrder` sobre una orden ya inexistente (OCO ya disparado/cancelado)
  → `OrderNotFound` → se trata como **éxito** (la posición ya no tiene OCO vivo → se procede al re-check).
- **FIX M3 — cancelación por leg:** `cancelOco` cancela vía `cancelOrder(legExchangeId, symbol)` usando el
  `exchange_order_id` de **una** leg (de `getBracketLegs`). En Binance spot, cancelar una leg cancela toda
  la order-list (verificado: `cancelOrder`→`privateDeleteOrder`, `binance.js`). El `orderListId` **no** se
  persiste, así que NO se usa `privateDeleteOrderList`. Guardas: si el `exchangeOrderId` de la leg es
  `null` (no debería en una posición protegida real) → saltar la cancelación; si se itera la segunda leg,
  su `OrderNotFound` es éxito. El método exacto se confirma contra ccxt real en el plan.
- **FIX L1 — moneda del fee:** `realized` resta `exitFee`/`entryFee` como escalares en quote; hereda la
  salvedad de SP13 (FIX M1): `order.fees[].cost` de ccxt puede venir en base/BNB. Mismo supuesto operativo
  ("fees en quote / descuento BNB desactivado en testnet"), verificado por el smoke. Sin esto, el P&L del
  `/cierra` divergiría del P&L del monitor/reconciler.
- **Reply best-effort:** el reply de WhatsApp es best-effort (no propaga), igual que SP11.
- **Validación en el límite:** símbolo normalizado y validado contra posiciones abiertas antes de tocar
  el exchange. Un símbolo desconocido nunca llega a ccxt.
- **Audit:** `position_closed_command` (éxito), `close_command_failed` (venta fallida tras cancel).

## Datos / esquema

Sin columnas nuevas. SP14 reusa `positions`/`orders`/`fills` y los repos de SP12/SP13
(`getBracketLegs`/`closeOpenPosition`/`closeBracketLegs`/`insertFill`) y el `emergencyClose` existente,
más una **cancelación de OCO** (ccxt, vía leg). **FIX M1 — nueva lectura** `getOpenPositionBySymbol(symbol,
mode): Promise<ReconcilePosition | null>` (positions.ts): posiciones `open` por `symbol+mode` **sin** los
filtros del monitor (`getOpenPositions` exige `sl/tp NOT NULL` + trigger-TF, lo que ocultaría posiciones
cerrables). Devuelve la fila con `strategyId`/`decisionId`/`entry`/`size`/`sl`/`tp`/`entryFee` (reusa la
forma `ReconcilePosition` de SP13). Si hay >1 con el mismo símbolo, devuelve una determinísticamente
(p.ej. la más reciente) y el comando avisa (supuesto testnet: una por símbolo — FIX M2).

## Líneas rojas de seguridad (verificar en el review)

- Ninguna tool de mutación en `tools:[]` de un agente. El `control-maker` sigue con `tools:[]` y el
  schema **`result`** que ve (`session.skill`) es el estricto **sin `cierra` ni `symbol`** (FIX H1) — el
  LLM es estructuralmente incapaz de rutear al cierre.
- Credenciales del exchange en closure (el cliente ccxt del cierre real se inyecta como dep, construido
  en el cableado con `getAuthenticatedClient`; el modelo nunca lo ve).
- Idempotencia: `closeOpenPosition` + `withSetupLock`. Reintentar `/cierra` nunca doble-vende.
- Nada toca dinero real sin el flag de modo: `sim` cierra sintético; solo `testnet|live` tocan el
  exchange.
- El cierre **reduce** exposición; jamás abre. SL/TP determinista intacto (SP14 no toca ese camino).

## Verificación

- **Unit:** parser `/cierra SYMBOL` (con/sin símbolo, normalización) y `/modo`; `ControlIntentSchema`
  extendido; `dispatchControl` (cierra con símbolo → llama closePosition; cierra sin símbolo → ayuda;
  modo → reporta); `closePositionCommand` sim (cierre sintético) y real (mock ccxt: cancel-OCO + sell +
  close; idempotente ante re-cierre; venta falla tras cancel → `setPositionProtected(false)` + audit, FIX
  H2; `getOpenPositionBySymbol` sin filtros del monitor, FIX M1); `cancelOco` (mock ccxt: cancela por leg,
  `OrderNotFound` = éxito). **Un test afirma que el picklist del `result` del `control-maker` NO contiene
  `cierra` ni `symbol`** (FIX H1).
- **Integración** (Postgres del compose): `closePositionCommand` real contra el grafo DB (posición →
  legs → cierre + P&L).
- **Smoke vigilado owner-gated** (fuera de CI): `/cierra BTC/USDT` real en testnet — cancela el OCO
  residente, vende a mercado, cierra con P&L real; verificar que el OCO desaparece del exchange y la
  posición queda `closed`. `/modo` reporta el modo correcto.
- **Cobertura 80%.** Córrelo de verdad antes de afirmar verde.

## Resultado

Completa los comandos de control de Fase 3: el owner puede **cerrar una posición** y **consultar el modo**
por WhatsApp, con el cierre por código determinista (cancel-first, idempotente, lock-guarded, falla
cerrado). El LLM queda fuera de la decisión de cierre. Pendiente tras SP14 para cerrar la Fase 3:
**trailing** (sprint propio). Luego Fase 4 (live). El smoke vigilado de `/cierra` queda owner-gated.
