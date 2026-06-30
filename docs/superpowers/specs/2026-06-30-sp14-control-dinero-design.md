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
  y el código lo valida contra las posiciones abiertas. El output del `control-maker` **excluye**
  `cierra` (picklist narrower). Esto saca al LLM por completo de la decisión de qué posición cerrar.
- **Cancel-first en el cierre real.** Cancelar el OCO residente **antes** de la venta de mercado evita
  (a) que el monitor cierre la posición por un fill del OCO en carrera y (b) que el OCO dispare durante
  la venta → anti doble-venta.
- **`/cierra` reduce exposición (no abre)** → riesgo intrínsecamente menor que el ejecutor; aun así pasa
  por código determinista, idempotente (`closeOpenPosition`) y serializado (`withSetupLock`).

## Alcance

### Dentro de SP14

1. **Extensión del esquema de intención** (`control-intent-schema.ts`): picklist
   `['estado','pausa','reanuda','cierra','modo','unknown']` + campo `symbol: v.optional(v.string())`
   (solo lo puebla el parser slash para `/cierra`).
2. **Parser slash** (`parse-control.ts`): `/cierra <symbol>` captura el símbolo (segunda palabra,
   normalizado); `/modo` mapea a `{command:'modo'}`. El resto sin cambios.
3. **Cierre real determinista** (módulo nuevo `src/lib/control/close-position-command.ts`): despacho por
   modo; `sim` cierra sintético, `testnet|live` cancela OCO → market sell → cierra. Lock-guarded.
4. **Despacho** (`dispatch-control.ts`): casos `cierra` (requiere símbolo; sin símbolo → ayuda) y `modo`
   (reporta el modo). `DispatchDeps` gana `closePosition(symbol)` y `currentMode`.
5. **Cancelación de OCO** (`src/lib/execution/real-order/cancel-oco.ts`): cancela la order-list residente
   de Binance vía ccxt (método verificado contra ccxt real en el plan).
6. **Cableado** (`evolution.ts`, `control-maker.ts`): extiende los tipos; el output del LLM excluye
   `cierra`; el skill `control-protocol` guía `/modo` (read-only) y a NO rutear cierre al LLM. Las deps
   del cierre real (cliente ccxt en closure) se construyen en el cableado.

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

### Cuatro puntos que hardcodean la lista de comandos (extender consistentemente)

1. `ControlIntentSchema` (picklist + `symbol`).
2. `parseSlashCommand` (mapa SLASH + captura de argumento para `cierra`).
3. `dispatchControl` (switch).
4. Los tipos del comando en `evolution.ts` (`ControlRouteDeps.dispatch`) y el output `v.object` del
   `control-maker`. **El output del LLM NO incluye `cierra`** (narrower que el schema completo).

### `/cierra <symbol>` — máquina de cierre con compensación (`close-position-command.ts`)

`closePositionCommand(symbol, deps): Promise<string>` (devuelve el texto de reply). Despacho por modo:

```
validar symbol ∈ posiciones abiertas del modo   → si no: "no hay posición abierta para {symbol}"

modo testnet|live:
  withSetupLock(strategyId, symbol, mode):
    pos = posición abierta para (strategy, symbol, mode)   ← re-check dentro del lock
    if !pos: return "ya cerrada / sin posición"
    cancelOco(client, legs de pos)            ← cancela el OCO residente (cancel-first)
    exit = emergencyClose(client, {symbol, qty: pos.size})   ← market sell IOC (reusa SP12)
    insertFill(exit) ; closeOpenPosition(pos.id, realized) ; closeBracketLegs
    audit 'position_closed_command' ; return "✅ {symbol} cerrada @ {exit} (pnl {realized})"

modo sim:
  pos = posición abierta ; cierra al último precio almacenado con sim fill (peor que mid)
  insertFill sintético ; closeOpenPosition ; closeBracketLegs ; return "✅ {symbol} cerrada (sim)"
```

- **Idempotencia:** `closeOpenPosition` solo cierra si `status='open'`; un `/cierra` repetido tras el
  cierre encuentra la posición ya cerrada en el re-check → noop ("ya cerrada"). El `withSetupLock`
  serializa vs el ejecutor y vs otro `/cierra` concurrente → no hay doble-venta.
- **P&L real:** `realized = (exit - entry) * size - exitFee - entryFee` (consistente con SP13).
- **Cancel-first:** tras cancelar el OCO, las legs quedan canceladas → el monitor (SP13) no las verá
  llenas; hará handoff (`protected=false`) en vez de cerrar. La posición la cierra `/cierra`.

### Modo de fallo declarado (no silenciar)

Si `emergencyClose` falla **tras** `cancelOco`: la posición queda `protected=false` (OCO cancelado, no
vendida) → el **reconciler A.2 de SP13 la re-protege** en su siguiente tick (re-arma un OCO). El reply
informa "cierre falló — posición re-protegida; reintenta". **Falla cerrado:** nunca queda desprotegida
indefinidamente (el reconciler la re-protege) ni se doble-vende (cancel-first). Deuda consciente de
testnet. *(El owner puede reintentar `/cierra`.)*

> **Carrera con el reconciler A.2 (declarada, aceptable en testnet):** entre `cancelOco` y
> `closeOpenPosition`, el monitor puede hacer handoff (`protected=false`) y el reconciler A.2 podría
> intentar re-proteger una posición que `/cierra` está cerrando. `closeOpenPosition` (atómico, idempotente)
> y `withSetupLock` acotan el daño a, en el peor caso, un OCO efímero re-armado y luego cancelado por el
> cierre. En testnet (play money) es aceptable; se endurece antes de live junto con el riesgo T6-b de SP13.

### `/modo` — solo-lectura

`dispatchControl` caso `modo`: devuelve `Modo actual: {currentMode}. (conmutar requiere reiniciar con
KAIROS_MODE=…; la conmutación en caliente llega en un sprint propio).` Sin efecto secundario.

## Manejo de errores

- **ccxt:** `cancelOco`/`emergencyClose` reutilizan el patrón de SP12 (NetworkError → retry con backoff;
  ExchangeError → no-retry). Un `cancelOrder` sobre una orden ya inexistente (OCO ya disparado) se trata
  como éxito (la posición ya no tiene OCO vivo → se procede según el re-check).
- **Reply best-effort:** el reply de WhatsApp es best-effort (no propaga), igual que SP11.
- **Validación en el límite:** símbolo normalizado y validado contra posiciones abiertas antes de tocar
  el exchange. Un símbolo desconocido nunca llega a ccxt.
- **Audit:** `position_closed_command` (éxito), `close_command_failed` (venta fallida tras cancel).

## Datos / esquema

Sin columnas nuevas. SP14 reusa `positions`/`orders`/`fills` y los repos de SP12/SP13
(`getOpenPositions`/`getBracketLegs`/`closeOpenPosition`/`closeBracketLegs`/`insertFill`). El cierre real
necesita una **cancelación de OCO** (ccxt) y el `emergencyClose` existente.

## Líneas rojas de seguridad (verificar en el review)

- Ninguna tool de mutación en `tools:[]` de un agente. El `control-maker` sigue con `tools:[]` y su
  output **excluye `cierra`** — el LLM no puede rutear al cierre.
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
  close; idempotente ante re-cierre; venta falla tras cancel → protected=false declarado);
  `cancelOco` (mock ccxt). El output del `control-maker` excluye `cierra` (un test lo afirma).
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
