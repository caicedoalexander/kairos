# SP11 — Canal de control WhatsApp inbound (Fase 2, separable)

**Fecha:** 2026-06-29
**Estado:** diseño (decisiones autónomas con criterio documentado; el owner pidió cerrar Fase 2). Pendiente de revisión por `kairos-design-reviewer`.

## Contexto: dónde encaja en Fase 2

Fase 2 núcleo (SP7→SP10) está completa en sombra: decision-maker LLM + analistas + escalación + risk-policy + A/B. SP11 es la **tercera capa** del principio rector (§3): **Notificación/Control**. La notificación *outbound* ya existe (`notify/whatsapp.ts`, template determinista). SP11 añade el **inbound de control**: el único punto donde un mensaje entrante reabre una sesión LLM para interpretar intención y ejecutar un **comando seguro determinista**.

SP11 es **separable** del núcleo (ARCHITECTURE §13): no toca el camino del razonamiento ni el del dinero.

## Meta

Completar el webhook Evolution existente (`src/channels/evolution.ts`, que ya verifica firma →
autoriza → audita, con el TODO "dispatch al control = Fase 2") para que un mensaje del número de
control: (1) se parsee a una **intención estructurada** (comandos slash deterministas; texto libre →
LLM Haiku), (2) ejecute un **comando seguro** (determinista), y (3) responda por WhatsApp (template).

## Alcance (acotado y seguro)

| Comando | Efecto | Toca dinero | SP11 |
|---|---|---|---|
| `/estado` | Read-only: posiciones abiertas, P&L realizado, exposición | No | ✅ |
| `/pausa` | Kill-switch ON: el scanner deja de disparar (previene trades) | No (previene) | ✅ |
| `/reanuda` | Kill-switch OFF | No | ✅ |
| *(texto libre)* | LLM interpreta → uno de los comandos anteriores o `unknown` | No | ✅ |
| `/cierra BTC` | `close_position` (mutación, exchange) | **Sí** | ⏸️ testnet |
| `/modo X` | Conmuta sim/testnet/live (muy sensible: podría ir a live) | **Sí** | ⏸️ testnet |

**Diferimiento justificado:** `/cierra` y `/modo` mueven dinero / cambian el modo de ejecución. Van con
el endurecimiento de **testnet** (OCO residente, lock Redis, reconciler ccxt — ya en pendientes de
CLAUDE.md), donde el plumbing de órdenes real existe y los guardrails de modo se prueban. SP11 entrega
la **capa de control** (estado + kill-switch + parsing LLM) sin riesgo sobre el dinero.

## Hechos de la API de Flue (a verificar en design-review)

- `invoke(workflow, { input })` fire-and-forget desde código in-process del servidor Flue (validado en
  SP7 desde un worker BullMQ en `app.ts`). **A confirmar:** que `invoke()` funcione desde un *channel
  route* (también in-process en el app Flue). Si no, fallback: encolar un job BullMQ `control-eval` +
  worker (patrón shadow exacto).
- `session.skill(name, { result })` con schema Valibot → `response.data` validado (usado en SP7-10).
- Skills/agentes descubiertos: `src/workflows/control-maker.ts` es descubierto como workflow (solo
  módulos descubribles ahí). El skill nuevo va en `src/skills/control-protocol/`.

## Arquitectura e integración

### Flujo

```
WhatsApp in → POST /channels/evolution/webhook
  handleEvolutionWebhook:
    verifyEvolutionWebhook (firma) → si no: 401
    isFromMe(body) === true → 200, descartar (H2: evita lazo con la propia respuesta saliente)
    isAuthorizedSender → si no: 200, ignorar (antes de tocar LLM/handlers)
    audit whatsapp.inbound
    void processControlMessage(text, sender, deps).catch(auditBestEffort)   ← ACK-THEN-PROCESS (M2)
    return 200   (rápido, no bloquea por DB/fetch saliente)

processControlMessage(text, sender, deps):   [desacoplado, best-effort]
    parseSlashCommand(text):
      intent conocido (estado/pausa/reanuda) → dispatchControl(intent, deps) → sendWhatsApp(reply, sender)   [sin LLM]
      null (texto libre)                      → invoke(controlMaker, { input: { text, sender } })             [fire-and-forget]
  control-maker.run(): session.skill('control-protocol', { result: ControlIntentSchema })
       → dispatchControl(intent, deps) → sendWhatsApp(reply, sender)
```

**H2 — guardia `fromMe`:** cuando el bot responde por `sendWhatsApp`, Evolution puede emitir un
`messages.upsert` saliente con `key.fromMe === true` y `remoteJid` = número de control. Sin la
guardia, `isAuthorizedSender` daría true y la **propia respuesta** se procesaría como comando →
lazo de realimentación (LLM + WhatsApp en bucle). El handler descarta (200) cualquier payload con
`key.fromMe === true` **antes** de autorizar — no se confía solo en la config de eventos de Evolution.

**M2 — ack-then-process:** el webhook responde **200 rápido** y procesa el comando de forma
**desacoplada** (`void processControlMessage(...).catch(...)`), tanto el camino slash (DB + envío
saliente) como el de texto libre (`invoke`). Evita exceder la ventana del webhook y maneja la promesa
flotante con un `catch` best-effort (sin `unhandledRejection` que tumbe el proceso).

El parsing slash determinista evita gastar LLM en el caso común (`/estado`, `/pausa`). El LLM (Haiku,
`low`) solo corre para texto libre. La lógica de despacho (`dispatchControl`) es **compartida** por
ambos caminos (webhook directo y workflow), sin duplicación.

### Componentes nuevos

1. **`src/lib/control/control-intent-schema.ts`** — `ControlIntentSchema` Valibot:
   `{ command: v.picklist(['estado', 'pausa', 'reanuda', 'unknown']) }`. `ControlIntent` tipo.
2. **`src/lib/control/parse-control.ts`** — `parseSlashCommand(text: string): ControlIntent | null`
   (determinista: `/estado`→estado, `/pausa`→pausa, `/reanuda`→reanuda; cualquier otra cosa → `null`
   = texto libre que necesita el LLM). Normaliza (trim, lowercase, acepta con/sin `/`).
3. **`src/db/repositories/bot-state.ts`** + tabla `kairos.bot_state` — single-row (`id text PRIMARY
   KEY DEFAULT 'singleton'`, `paused boolean NOT NULL DEFAULT false`, `updated_at`). `getPaused()` /
   `setPaused(paused: boolean)` (upsert del singleton).
4. **`src/lib/control/dispatch-control.ts`** — `dispatchControl(intent: ControlIntent, deps:
   DispatchDeps): Promise<string>` (devuelve el texto de respuesta). Handlers:
   - `estado` → `deps.getOpenPositions()` + agrega P&L/exposición → template legible.
   - `pausa` → `deps.setPaused(true)` → "⏸️ Bot pausado: el scanner no disparará."
   - `reanuda` → `deps.setPaused(false)` → "▶️ Bot reanudado."
   - `unknown` → texto de ayuda con los comandos disponibles.
   `DispatchDeps` inyectable (`getOpenPositions`, `setPaused`) → testeable sin DB.
5. **`src/skills/control-protocol/SKILL.md`** — doctrina: mapea el texto del usuario a uno de
   `estado`/`pausa`/`reanuda`; si no está claro o pide algo no soportado (cerrar, cambiar modo),
   `unknown`. Guía interpretación, no añade capacidad.
6. **`src/workflows/control-maker.ts`** — `defineWorkflow`. Agente de control (Haiku, `thinkingLevel:
   'low'`, `skills: [controlProtocol]`, **`tools: []`** — línea roja). `input = { text, sender }`.
   `run()`: `session.skill('control-protocol', { args: { text }, result: ControlIntentSchema })` →
   `dispatchControl(intent, deps)` → `sendWhatsApp(reply, sender)`.

### Componentes modificados

7. **`src/channels/evolution.ts`** — gana: `isFromMe(body): boolean` (lee `data.key.fromMe`, H2) y
   `extractMessageText(body): string | null` (maneja las dos formas reales del payload Evolution:
   `data.message.conversation` y `data.message.extendedTextMessage.text`, L2). `handleEvolutionWebhook`
   descarta `fromMe` (200), y tras el audit lanza `processControlMessage` **desacoplado** (M2) y
   devuelve 200. `processControlMessage(text, sender, deps)` (nuevo, deps inyectables: parse/dispatch/
   invoke/sendWhatsApp) hace el ruteo slash/LLM. El webhook devuelve 401 solo por firma.
8. **`src/lib/scanner/scan-tick.ts`** — `ScanTickDeps` gana `isPaused: () => Promise<boolean>`; al
   inicio del tick, si `isPaused()` → audita `scan_paused` y retorna `{ scanned: 0, fired: 0,
   enqueued: 0 }` sin recorrer estrategias (optimización barata: evita encolar). El default cablea
   `getPaused` del repo.
9. **`src/orchestration/evaluate-candidate.ts`** (H1 — enforcement duro) — al inicio de
   `evaluateCandidate`, consultar `isPaused()`: si está pausado → audita `kill_switch_blocked` y
   retorna **antes** de `buildDeterministicVerdict`/`check_risk`/`executeOrderSim`, sin abrir posición.
   Esto **cierra la ventana de jobs ya encolados** antes de `/pausa` (el scanner solo evita encolar
   *nuevos*; el worker procesa los que ya estaban en la cola). Alinea con §53 (kill-switch = límite
   duro del camino de ejecución, no solo del scanner). `isPaused` se inyecta como dep (default
   `getPaused`); el camino del dinero sigue determinista.

## Contrato `ControlIntent` (Valibot)

```ts
export const ControlIntentSchema = v.object({
  command: v.picklist(['estado', 'pausa', 'reanuda', 'unknown']),
});
export type ControlIntent = v.InferOutput<typeof ControlIntentSchema>;
```

`unknown` cubre todo lo no soportado (incluidos `/cierra`/`/modo`, que en SP11 responden con el texto
de ayuda — "comando no disponible aún"). Cuando lleguen (testnet), se añaden al picklist + un handler.

## Esquema `bot_state`

```sql
CREATE TABLE IF NOT EXISTS kairos.bot_state (
  id         text PRIMARY KEY DEFAULT 'singleton',
  paused     boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kairos.bot_state (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
```

`setPaused` hace upsert del singleton; `getPaused` lee (default `false` si la fila no existe).

## Resiliencia y líneas rojas

- **El agente de control no toca dinero ni gatilla:** `tools: []`; solo emite `ControlIntent`
  estructurado. Los handlers (`dispatchControl`) son deterministas y SP11 solo incluye comandos
  seguros (read + kill-switch). La línea roja "el LLM juzga/clasifica, el código ejecuta" se mantiene.
- **Autorización:** ya garantizada por `isAuthorizedSender` (solo `WHATSAPP_CONTROL_NUMBER`); el
  webhook ignora (200) cualquier remitente no autorizado **antes** de tocar el LLM o los handlers.
- **Kill-switch determinista en DOS puntos (H1):** `pausa` (a) hace que el scanner no dispare
  (barato, evita encolar) **y** (b) hace que `evaluateCandidate` rechace antes de ejecutar (cierra la
  ventana de jobs ya encolados). Es el enforcement duro de §53. Reversible y auditado. *Previene*
  trades; no ejecuta nada. (M3: en `sim` el flag vive solo en Postgres `bot_state`, leído por tick/job;
  ARCHITECTURE §276 prevé una copia caliente en Redis `kairos:killswitch` — **diferida a testnet**,
  donde scanner y control pueden correr en procesos distintos y la latencia de la copia importa.)
- **Fallo del LLM (L3):** si `session.skill` no produce un `ControlIntent` válido (Valibot lanza /
  `ResultUnavailableError`), `control-maker.run()` lo atrapa (best-effort) y responde el texto de
  ayuda (equivalente a `unknown`) — nunca propaga ni deja al usuario sin respuesta.
- **Best-effort:** un fallo del parsing LLM o del envío de respuesta se audita y no propaga (el
  webhook ya respondió 200); nunca tumba el proceso. El money path y el scanner no dependen del
  control inbound.
- **Idempotencia:** los comandos son idempotentes por naturaleza (`pausa` dos veces = pausado;
  `estado` es read-only). No se requiere dedup de mensajes en SP11 (un comando repetido es inocuo).

## Estrategia de testing

- **`parseSlashCommand` (unit):** `/estado`→estado, `/pausa`→pausa, `/reanuda`→reanuda, variantes
  (mayúsculas, sin `/`, con espacios), texto libre → null.
- **`ControlIntentSchema` (unit):** válido / picklist inválido.
- **`bot_state` repo (integración):** `setPaused(true)`→`getPaused()===true`; upsert idempotente.
- **`dispatchControl` (unit):** deps inyectadas — estado (posiciones falsas → template contiene los
  símbolos/P&L), pausa (llama `setPaused(true)` + reply), reanuda, unknown (texto de ayuda).
- **`scan-tick` (unit):** `isPaused: async () => true` → no recorre estrategias, retorna ceros + audita
  `scan_paused`; `isPaused: false` → comportamiento normal (los tests existentes siguen verdes con el
  default `isPaused: false`).
- **`evaluateCandidate` (unit, H1):** `isPaused: async () => true` → audita `kill_switch_blocked` y
  retorna sin llamar a `executeOrder`/sizing; `isPaused: false` → comportamiento normal (los tests
  existentes de evaluate-candidate siguen verdes con el default).
- **Webhook (unit/integración):** un mensaje slash autorizado → llama `dispatchControl` + reply; texto
  libre → llama `invoke`; remitente no autorizado → 200 sin dispatch; **`fromMe === true` → 200 sin
  dispatch (H2)**; firma inválida → 401. `extractMessageText` parsea ambas formas del payload.
- **`control-maker` (glue):** validado por typecheck + smoke; sin unit propio (la lógica vive en
  parse/dispatch ya testeados).
- **Smoke vivo (owner-gated):** con Evolution configurado, enviar `/estado` y un texto libre ("¿cómo
  va?") desde el número de control; verificar la respuesta. Requiere la instancia Evolution viva — no
  lo puede driver el agente solo. Alternativa de validación sin Evolution: invocar `control-maker` con
  `flue run` (texto libre → intent) y verificar el dispatch contra la DB.
- Cobertura ≥ 80%; `npm run typecheck` en verde.

## Criterios de éxito

- `/estado` desde el número de control responde con posiciones/P&L/exposición (read-only).
- `/pausa` pone el kill-switch ON; el siguiente `scan-tick` no dispara (audita `scan_paused`);
  `/reanuda` lo revierte.
- Texto libre ("pausa el bot", "¿cómo va?") → el LLM lo mapea al comando correcto (o `unknown`).
- Un remitente no autorizado nunca alcanza el LLM ni los handlers (200, ignorado).
- El agente de control no tiene tools de mutación; solo emite `ControlIntent`.
- `npm test` + `npm run typecheck` en verde; cobertura ≥ 80%.
- Smoke (owner o `flue run control-maker`): texto libre produce un `ControlIntent` válido y el dispatch
  correcto.

## Desviación de ARCHITECTURE (declarada, M1)

ARCHITECTURE §11/§65/§393-396 especifica el Control como **agente continuo** (`agents/control.ts`)
alcanzado por `dispatch(control)`. SP11 lo implementa como un **workflow** (`workflows/control-maker.ts`)
invocado con `invoke()`. **Justificación:** cada comando es *stateless* (sin memoria entre mensajes),
y la doc de Flue recomienda un workflow finito sobre un agente continuo cuando el trabajo no continúa
a través de mensajes (`workflows.md:7`). Un agente continuo añadiría estado de sesión innecesario.
El plan **actualiza ARCHITECTURE §11/§65/§393-396** para reflejar `agent`→`workflow` y
`dispatch`→`invoke` (no se deja el doc rector contradiciendo el código).

## Hallazgos de revisión de diseño (resueltos en este spec)

Revisado por `kairos-design-reviewer` contra la doc real de Flue (workflows.md, workflow-api.md,
channels.md, skills.md) y ARCHITECTURE.md. `invoke()` desde un channel route **confirmado válido**
("ambient `invoke()` from ... routes, channels, schedules", workflows.md:62-71). Sin CRITICAL.
Resoluciones:

- **H1 — kill-switch in-flight:** el chequeo solo en el scanner no detenía los jobs ya encolados. Se
  añade el enforcement en `evaluateCandidate` (deny/return antes de ejecutar), cerrando la ventana y
  alineando con §53. El scanner conserva el chequeo como optimización.
- **H2 — lazo `fromMe`:** guardia `isFromMe(body) === true → 200, descartar`, antes de autorizar, para
  que la respuesta saliente del bot no re-entre como comando.
- **M1 — desviación agente→workflow:** declarada arriba; el plan actualiza ARCHITECTURE.
- **M2 — ack-then-process:** el webhook responde 200 rápido y procesa desacoplado (slash y texto libre)
  con `catch` best-effort.
- **M3 — Redis hot-copy:** anotada como diferida a testnet (en `sim`, Postgres-only es suficiente).
- **L2 — `extractMessageText`:** maneja `conversation` y `extendedTextMessage.text`.
- **L3 — fallo del skill:** `control-maker` atrapa y responde ayuda.
- **L1 — redelivery sin dedup:** aceptado (comandos idempotentes); reconocido, deduplicable por
  `key.id` si molesta (YAGNI por ahora).

## Fuera de alcance de SP11

- `/cierra` (close_position) y `/modo` (conmutar sim/testnet/live) — van con testnet.
- Circuit-breaker / `pending_approvals` (resolución de aprobaciones por WhatsApp) — opcional, default
  OFF (§19); no es parte del control mínimo.
- Dedup de mensajes inbound (innecesario: comandos idempotentes).
- Conversación multi-turno / memoria de control (YAGNI: cada comando es stateless).
