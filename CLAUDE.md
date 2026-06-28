# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Idioma: este proyecto trabaja en español. Documentación, comentarios y mensajes en español; identificadores de código en su forma original.

## Estado del proyecto

**Fase 1 COMPLETA en `sim` (sin LLM) — loop entrada→salida cerrado.** Ya hay implementación real en
`src/` (scanner, ejecución, market-data, backtester, repos de dominio, cola BullMQ, worker, monitor
de salida, reconciler, graceful shutdown).
Existen `flue.config.ts`, `tsconfig.json`, `vitest.config.ts`, `docker-compose.yml` (Postgres +
Redis) y `package.json` con scripts. La estructura `src/...` de los docs es en buena parte real,
pero **verifica siempre que un archivo existe antes de asumirlo** (aún falta lo de Fase 2+).

Progreso por sprints (SP):
- **SP1–SP4 (hechos):** tipos/schemas Valibot y límites de ejecución; repos de dominio (esquema
  `kairos`); camino del dinero en `sim` (sizing, `check_risk`, `execute_order` idempotente,
  bracket OCO); backtester (replay histórico + métricas) con CLI `npm run backtest`.
- **SP5 (hecho):** loop de **entrada** vivo en `sim` — `scan-tick` recorre estrategias y encola →
  worker BullMQ → `evaluateCandidate` (veredicto **determinista**, todavía sin LLM) → `check_risk`
  → `execute_order` sim → notify best-effort. Validado end-to-end en vivo. Plan en
  `docs/superpowers/plans/2026-06-28-sp5-loop-entrada-vivo.md`.
- **SP6 (hecho):** cierre de Fase 1 en `sim` — **monitor de salida** (`monitor-tick`: resuelve SL/TP
  barra-a-barra reusando `resolveBracket`, anti-look-ahead vía `open_time > opened_at`, cierre OCO
  transaccional + notify best-effort); **dedup per-setup** (índice único parcial
  `idx_positions_open_setup` + status `deduped` en `executeOrderSim` + pre-check en `evaluateCandidate`
  + audit `entry_deduped`) — **ya NO es bloqueador de testnet**; **graceful shutdown** (SIGTERM/SIGINT,
  cierra workers/queues/conn/pool); **reconciler delgado** de arranque (audita entries colgadas y legs
  huérfanas; sin ccxt — el diff contra exchange es de testnet). Plan en
  `docs/superpowers/plans/2026-06-28-sp6-cierre-fase1.md`. Después: capa de **razonamiento**
  (decision-maker LLM + analistas).

> Pendientes antes de **testnet** (no de sim): OCO residente en el exchange (SL/TP inmediato real, no
> polling por cierre de vela), lock Redis por candidato (§273), reconciler con `fetch` de ccxt, y
> mantener `kairos.ohlcv_candles` al día (cadencia de backfill ≤ `MONITOR_INTERVAL_MS`).

> Nota: `evaluate-candidate` se implementó como **función de orquestación** dirigida por código
> (no `defineWorkflow` descubierto) porque en Fase 1 no hay `session` LLM; en Fase 2 los pasos
> post-veredicto se reusan dentro de un handler de Flue. Es una desviación consciente de §12.

`ARCHITECTURE.md` es la **fuente de verdad** del diseño (14 secciones: agentes, flujos,
skills, tools, estado, modelos, ejecución, riesgos, fases). Léelo antes de implementar o
cambiar el rumbo. Cualquier desviación del diseño debe justificarse, no hacerse en silencio.

## Principio rector (no negociable)

**El LLM tiene juicio, no gatillo.** Los modelos solo *miran* y *proponen*; mover dinero es
siempre código determinista, idempotente y auditable. Esto separa el sistema en tres capas:

1. **Determinista (sin LLM)** — scanner/señales, `check_risk`, `execute_order`, monitor de
   posiciones, reconciler. Aquí vive todo lo que toca dinero.
2. **Razonamiento (LLM)** — decision-maker + analista técnico + analista fundamental +
   control de WhatsApp. Solo lectura; emite un veredicto estructurado.
3. **Notificación (sin LLM)** — WhatsApp se renderiza por template desde el registro de
   decisión (sin alucinación). Solo el *inbound* de control reabre una sesión LLM.

Flujo central (`workflows/evaluate-candidate.ts`): scanner detecta setup → encola job →
decision-maker delega a los analistas y emite veredicto (Valibot) → `check_risk`
(determinista) → si `allow`, `execute_order` (idempotente, ccxt) → notify (template).

## Comandos

Setup local: `npm install` → `docker compose up -d` (Postgres + Redis `noeviction`) →
`npm run migrate` → `npm run seed`. Config en `.env` (ver `.env.example`): `DATABASE_URL`,
`REDIS_URL`, `REDIS_BULLMQ_URL`, credenciales de Evolution (`EVOLUTION_API_URL/KEY/INSTANCE`,
`WHATSAPP_CONTROL_NUMBER`), `KAIROS_MODE` (default `sim`).

Scripts (`package.json`):
- `npm test` / `npm run test:watch` — Vitest. Incluye **tests de integración** que tocan el
  Postgres del compose (requieren `DATABASE_URL`); la suite unit no toca Redis. Cobertura 80%.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run migrate` / `npm run seed` — crea el esquema `kairos` y la estrategia semilla.
- `npm run backfill` — descarga OHLCV/funding/OI (ccxt público) al esquema `kairos`.
- `npm run backtest` — replay histórico determinista (reporte + persistencia).
- `npm run worker` — **proceso vivo**: worker de la cola `evaluate-candidate` + scan tick
  repetible (BullMQ; necesita Redis). `SCAN_INTERVAL_MS` ajusta la cadencia.
- `npm run dev` / `npm run build` / `npm start` — Flue Node target (`@flue/cli`).

**Córrelo de verdad antes de afirmar que pasa** — no declares verde sin ejecutar.

## Trabajar con Flue (regla crítica)

**Verifica la API de Flue contra su documentación real, nunca de memoria.** Tras `npm install`,
la doc vive en `node_modules/@flue/runtime/docs/` (`guide/`, `concepts/`, `api/`) y los tipos
exactos en `node_modules/@flue/runtime/types/` + los `.d.ts`. Antes de usar `defineAgent`/
`defineTool`/`defineWorkflow`/`defineAction`/`session.*`/canales/`db.ts`, abre el doc y
confirma firma y contrato. Flue está en `1.0.0-beta.5`; las firmas pueden no coincidir con tu
intuición.

Restricciones de Flue que **moldearon el diseño** (no las re-litigues sin releer la doc):

- **No hay RPC agente-a-agente.** La orquestación es **subagentes** (`session.task({ agent, result })`)
  o **workflows** dirigidos por código. Marca cualquier "agente A llama al endpoint de agente B".
- **Cloudflare Workers no corre el loop** (sin `while(true)`/websockets, cron ≥1 min, fuerza
  Durable Object SQLite). El cerebro vive en el **Node target del VPS**, con Postgres.
- **Flue no persiste datos de dominio** — su store guarda solo sesiones/runs/eventos.
  Posiciones, señales, decisiones, órdenes, P&L y config van a un **esquema propio** (`kairos`)
  en el mismo Postgres.
- **Los canales no deduplican; la idempotencia es de la app.** Flue solo reintenta cuando el
  replay es demostrablemente seguro y marca como fallido lo incierto.
- **Los workflows no son reanudables a medio paso** — un flujo que "espera" a un humano no
  puede ser un workflow pausado (por eso el circuit-breaker usa un registro `pending_approval`
  resuelto por el canal de control, no una pausa de workflow).
- **`@flue/whatsapp` solo habla WhatsApp Cloud API de Meta** (firma `X-Hub-Signature-256`),
  incompatible con Evolution API → se usa un **canal custom** + tool de salida al REST de Evolution.
- **Node no auto-termina workflow runs interrumpidos** (quedan `active`) → **BullMQ** es la
  espina durable de cola/scheduler (retries, stalled jobs); por eso necesita Redis `noeviction`.

## Líneas rojas de seguridad (CRITICAL — bloquean commit si se violan)

- **Ninguna tool de mutación** (`execute_order`, `close_position`, `cancel_order`,
  `set_stop_take`, `check_risk`) está en el `tools:[]` de un agente/modelo. Solo las llama
  código determinista de orquestación. El bucle de tool-calling del LLM jamás dispara una orden.
- **Toda orden lleva `idempotency_key`** con `UNIQUE` en `orders`, y el claim (lock Redis)
  ocurre **antes** de tocar el exchange. Reintentar nunca duplica.
- **Credenciales del exchange y account-id en closures** (factory que recibe la identidad del
  agente), nunca en el `input` que elige el modelo. El modelo elige `symbol`/`size`, jamás la
  cuenta ni la key.
- **SL/TP duro es determinista e inmediato** — cortar pérdidas nunca espera a una llamada LLM.
- **Modo `sim|testnet|live` explícito y persistido**; nada toca dinero real sin el flag.
  `sim` (default) llena contra datos reales sin tocar el exchange; en sim, modela siempre
  precio peor que el mid (spread + slippage + fees) o el backtest miente.
- Ante incertidumbre de ejecución, **nunca se asume una orden ejecutada** — queda
  `pending_execution` y se notifica (regla de durabilidad de Flue).

> El owner eligió **autonomía total** (ejecuta sin aprobación humana por trade) a sabiendas.
> La seguridad es por construcción vía estos guardrails deterministas, no por revisión manual.
> El circuit-breaker (`needs_approval`) es opcional y por defecto **OFF**.

## Convenciones de implementación

- **Validación con Valibot** (no zod) para `input`/`output` de tools/actions/workflows y para
  el veredicto del decision-maker (`result: v.object({...})` fuerza JSON validado, no prosa).
- **Skills** (Markdown de doctrina, en `src/skills/`) se importan con `with { type: 'skill' }`;
  el `name` del frontmatter = nombre del directorio. Los skills **guían el razonamiento, no
  añaden capacidad ejecutable**. Las estrategias son config declarativa en Postgres, no skills.
- **`src/db.ts`** exporta por default el adapter `postgres(process.env.DATABASE_URL!)` (store
  de Flue). Los datos de dominio van por repositorios propios al esquema `kairos`, append-first.
- **Subagentes** declarados como profiles en `subagents:[]` y delegados con `session.task`.
- **Reconciliación exchange↔DB al arranque** antes de que el scanner dispare (pendiente, SP6).
- **La notificación es best-effort**: un fallo de `notify` (Evolution caído/mal configurado) se
  audita (`notify_failed`) y **nunca** propaga ni tumba el job tras ejecutar — la capa de
  notificación está separada de la de ejecución (`notifyBestEffort` en `evaluate-candidate.ts`).
- **Idempotencia en dos capas**: `jobId = signalId` deduplica el encolado (BullMQ) y
  `UNIQUE(idempotency_key)` (= `signalId`) deduplica la ejecución. Reintentar nunca duplica.
- Estilo: funciones <50 líneas, archivos <800, sin anidamiento >4 niveles, inmutabilidad por
  defecto, validación en los límites, sin secretos hardcodeados, sin `console.log` de debug.

## Tooling de Claude en este repo

Usa los **agentes revisores a medida** (`.claude/agents/`) en su momento del ciclo. Todos
verifican contra la doc real de Flue y `ARCHITECTURE.md`, no de memoria:

- `kairos-design-reviewer` — al cambiar `ARCHITECTURE.md` o proponer un subsistema nuevo.
- `kairos-plan-reviewer` — tras generar un plan de implementación, antes de ejecutarlo.
- `kairos-implementation-reviewer` — tras escribir/modificar código, antes de commitear.

**Skills** (`.claude/skills/`): `ccxt-typescript` (uso correcto de ccxt) y
`llm-trading-agent-security` (seguridad de agentes de trading con autoridad de ejecución).

## Orden de fases (importa)

Andamiaje → **loop determinista en `sim` sin LLM** (valida el pipeline end-to-end gratis) →
razonamiento (sigue en `sim` para medir edge) → **testnet** (plumbing real de órdenes) →
**live** con poco capital. No gastes en modelos antes de que el loop determinista funcione en
sim; no toques dinero real antes de validar en sim y testnet. Dashboard, futures, shorts y
multi-exchange están **fuera de alcance** por ahora (no los construyas — YAGNI).

**Dónde estamos:** Fase 1 **completa** en `sim` — el loop determinista entrada→salida corre cerrado
(SP5 entrada + SP6 salida/dedup/shutdown/reconciler). El dedup per-setup ya está (índice único
parcial), así que el riesgo de apilar posiciones está domado. Siguiente: la capa de **razonamiento**
(decision-maker LLM + analistas), todavía en `sim` para medir edge; luego **testnet** (ver pendientes
de testnet en Estado del proyecto: OCO residente, lock Redis, reconciler ccxt, backfill al día).
