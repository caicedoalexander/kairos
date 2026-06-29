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
  handleEvolutionWebhook (ya): verifyEvolutionWebhook → isAuthorizedSender → audit whatsapp.inbound
  + NUEVO: extractMessageText(body) → parseSlashCommand(text):
       intent conocido (estado/pausa/reanuda) → dispatchControl(intent, deps) → sendWhatsApp(reply, sender)   [sin LLM]
       null (texto libre)                      → invoke(controlMaker, { input: { text, sender } })             [fire-and-forget]
  control-maker.run(): session.skill('control-protocol', { result: ControlIntentSchema })
       → dispatchControl(intent, deps) → sendWhatsApp(reply, sender)
```

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

7. **`src/channels/evolution.ts`** — `handleEvolutionWebhook` gana, tras el audit: extraer el texto
   del mensaje, `parseSlashCommand` → dispatch directo + reply, o `invoke(controlMaker, …)`. Deps
   inyectables para test (parse/dispatch/invoke/reply). El webhook sigue devolviendo 200 siempre
   (Evolution no reintenta) salvo 401 por firma.
8. **`src/lib/scanner/scan-tick.ts`** — `ScanTickDeps` gana `isPaused: () => Promise<boolean>`; al
   inicio del tick, si `isPaused()` → audita `scan_paused` y retorna `{ scanned: 0, fired: 0,
   enqueued: 0 }` sin recorrer estrategias. El default cablea `getPaused` del repo.

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
- **Kill-switch determinista:** `pausa` *previene* trades (el scanner no dispara); no ejecuta nada.
  Es reversible y auditado.
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
- **Webhook (unit/integración):** un mensaje slash autorizado → llama `dispatchControl` + reply; texto
  libre → llama `invoke`; remitente no autorizado → 200 sin dispatch; firma inválida → 401.
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

## Fuera de alcance de SP11

- `/cierra` (close_position) y `/modo` (conmutar sim/testnet/live) — van con testnet.
- Circuit-breaker / `pending_approvals` (resolución de aprobaciones por WhatsApp) — opcional, default
  OFF (§19); no es parte del control mínimo.
- Dedup de mensajes inbound (innecesario: comandos idempotentes).
- Conversación multi-turno / memoria de control (YAGNI: cada comando es stateless).
