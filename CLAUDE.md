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
  `docs/superpowers/plans/2026-06-28-sp6-cierre-fase1.md`.
- **SP7 (hecho) — arranca Fase 2 (Razonamiento):** primer LLM, en **sombra**. Workflow Flue
  `decision-maker` (`session.skill('decision-protocol', { result })` → veredicto Valibot; agente
  **sin tools de mutación**) corre vía cola `shadow-eval` (worker en `app.ts`, `invoke` fire-and-forget)
  y persiste a `kairos.shadow_verdicts` **junto al determinista** para A/B. El dinero (sim) **sigue
  ejecutando el determinista** — el LLM no toca el camino del dinero. Validado con smoke vivo real
  (Sonnet emitió un veredicto válido). Plan en `docs/superpowers/plans/2026-06-28-sp7-cimiento-llm-shadow.md`.
  Fase 2 se decompone en SP7→SP10 (núcleo) + SP11 (control, separable); ver el spec.
- **SP8 (hecho) — primer subagente:** **analista técnico** (Haiku, solo lectura, `tools: []`) al que el
  decision-maker delega vía `session.task({ agent: 'technical-analyst', result })` **antes** de
  sintetizar el veredicto. El código dirige la delegación (paso `analyze` en `runDecisionMaker`, sobre
  una **sesión dedicada** `harness.session('technical')`), no el modelo. El subagente emite un
  `technical_read` Valibot (bias/confluence/regime/divergence/mtfNote/notes) guiado por el skill
  `technical-read`; se persiste junto al veredicto en `kairos.shadow_verdicts` (columnas
  `technical_read/technical_model/technical_tokens`) para A/B. **Degradación best-effort:** si el
  analista falla → `technical_read=null` + audit `technical_read_failed`, el veredicto se emite igual.
  Sigue en **sombra** sobre `sim`. Plan en `docs/superpowers/plans/2026-06-28-sp8-analista-tecnico.md`.
  Validado con smoke vivo real: Haiku emitió un `technical_read` válido vía la **sesión nombrada**
  (`harness.session('technical').task(...)` funciona en runtime — desconocido M1 resuelto), Sonnet
  integró el read (sizing 0.75 reflejó la cautela del analista), persistido en `shadow_verdicts` con
  `technical_model`/`technical_tokens`. Sin degradación.
- **SP9 (hecho) — analista fundamental condicional:** segundo subagente (**fundamental**, Haiku, solo
  lectura, `tools: []`) + primera fuente externa (**noticias por RSS**). El código dirige una
  invocación **condicional**: `isMajorCap` (BTC/ETH) **antes** del fetch → `fetchNews`
  (best-effort, con caché, sin API key — nunca al prompt) → gate determinista
  `shouldRunFundamental` (catalizador en ventana **O** derivados extremos) → analista solo si pasa.
  Emite `fundamental_read` (bias/catalysts/positioning/decayNote?/confidence) guiado por
  `fundamental-read`; modula el veredicto (veto/cautela/refuerzo, §17.4). Persistido en
  `shadow_verdicts` (`fundamental_read/model/tokens/status/fetch_ok`); `fundamental_status` ∈ {ran,
  skipped_not_major, skipped_quiet, skipped_fetch_failed, failed} + `fetch_ok` dan sustrato limpio al
  A/B. **Degradación en dos capas** (fetch + analista). Validado con smoke vivo: el fundamental corrió
  por la rama de derivados extremos (sin key de CryptoPanic), leyó `positioning='crowded_long'` y el
  decision-maker **bajó sizing a 0.45** por el hacinamiento. Plan en
  `docs/superpowers/plans/2026-06-28-sp9-analista-fundamental.md`.
  *Fuente de noticias: **RSS** (`src/lib/sources/news.ts`, CoinTelegraph por default, `NEWS_RSS_URL`
  configurable, sin API key) — se migró desde CryptoPanic cuando su free tier se discontinuó
  (2026-04-01). El camino de noticias funciona out-of-the-box; el gate también abre por derivados extremos.*
- **SP10 (hecho) — cierre del núcleo de Fase 2:** (1) **escalación determinista Sonnet→Opus** —
  `shouldEscalate` (puro: confianza baja **O** analistas opuestos) dispara una **segunda pasada
  deliberada** con Opus sobre una sesión dedicada `harness.session('escalation')`; **el código decide,
  no el modelo**. Resiliencia (reintenta el mismo modelo ante blip) y escalación quedan separadas
  (se retiró `DECISION_MODEL_ESCALATION`; ahora `ESCALATION_MODEL ?? anthropic/claude-opus-4-6`).
  Best-effort: Opus falla → degrada a Sonnet + audit `escalation_failed`; persiste `escalated`.
  (2) **skill `risk-policy`** — doctrina cualitativa de cautela/sizing registrada junto a
  `decision-protocol` (los límites duros siguen en `check_risk`). (3) **medición A/B** — CLI read-only
  `npm run shadow-report` que une `shadow_verdicts` (LLM) ⨝ `decisions` (determinista) ⨝ `positions`
  (P&L) por señal y reporta acuerdo de acción (4 cuadrantes), escalación, y `sizingEdge` (acotado: solo
  mide sizing, no la divergencia SL/TP del LLM). Validado con smoke vivo: la pasada **Opus corrió**
  (`escalated=true`, `model_used=opus`), risk-policy movió el sizing, y el reporte contó la escalación.
  Plan en `docs/superpowers/plans/2026-06-29-sp10-escalacion-riskpolicy-ab.md`. **Fase 2 núcleo
  (SP7→SP10) COMPLETA en sombra; queda SP11 (control WhatsApp, separable).**
- **SP11 (hecho) — canal de control WhatsApp inbound (cierra Fase 2):** completa el webhook Evolution
  (firma → **guardia `fromMe`** → autoriza → audita → **ack-then-process** desacoplado). El mensaje se
  parsea (comandos slash deterministas; texto libre → workflow `control-maker` con Haiku `low`,
  **`tools: []`** — solo clasifica a un picklist cerrado; el código ejecuta). Comandos seguros:
  **`/estado`** (read-only) y **`/pausa`/`/reanuda`** (kill-switch `bot_state.paused`, aplicado en DOS
  puntos: `scan-tick` evita encolar **y** `evaluateCandidate` hace hard stop de jobs en cola, §53).
  `/cierra` y `/modo` (tocan dinero) **diferidos a testnet**. Validado con smoke vivo: texto libre
  ("pausa el bot", "reanuda", "¿cómo va?") se clasificó a `pausa`/`reanuda`/`estado` y el kill-switch
  cambió `bot_state`. Plan en `docs/superpowers/plans/2026-06-29-sp11-control-whatsapp.md`.
  **🎉 FASE 2 COMPLETA en sombra.** Siguiente: **testnet** (ver pendientes abajo).
- **SP12 (hecho) — arranca Fase 3 (Testnet):** **ejecutor real** del camino del dinero. Despacho por
  modo en `evaluateCandidate` (`sim → executeOrderSim` intacto; `testnet|live → executeOrderReal`).
  `executeOrderReal` (`src/lib/execution/execute-order-real.ts`) es una máquina de estados determinista
  con compensación: **lock Redis por setup** (`withSetupLock`, fail-closed) → re-check dedup dentro del
  lock → claim DB idempotente → **entrada limit marketable IOC capada** (ccxt `createOrder`) → fills
  reales → posición `protected=false` → **OCO residente server-side** (SL stop-limit + TP limit-maker
  vía `privatePostOrderListOco`, qty **neta de fee**) → `protected=true`. Fallo de OCO o carrera de
  setup (23505) → **cierre de emergencia** (market IOC). Lo que crashee/quede incierto se marca durable
  (`positions.protected=false`, `orders.status='pending_execution'`/`'pending'`) para el reconciler de
  SP13. Columna nueva `positions.protected` (default `false`, crash-safe). El LLM **sigue en sombra**.
  Validado con la **suite (347/347)**; el **smoke vigilado en testnet real** (valida la llamada OCO de
  Binance) queda **owner-gated, pendiente**. Plan en
  `docs/superpowers/plans/2026-06-29-sp12-ejecutor-real-testnet.md`. **Gate: sólo smoke vigilado; el
  loop continuo desatendido se habilita en SP13** (ver precondición dura I1 en el spec §Seguridad:
  doble-compra secuencial tras fill incierto — no habilitar el loop sin el reconciler ccxt).
- **SP13 (hecho) — reconciler/monitor ccxt + frescura OHLCV (cierra Fase 3 en código):**
  (1) **Reconciler ccxt** (`src/lib/reconcile/exchange-reconcile.ts`, `runExchangeReconcile`): corre en
  arranque + tick periódico (5 min) en modo real. **A.1** resuelve entradas inciertas
  (`pending`/`pending_execution`) contra el exchange por `clientOrderId` — si llenada: abre posición,
  registra fill real y re-protege (OCO); si no llenada: cancela. **A.2** reconcilia posiciones
  desprotegidas (`protected=false`) — si OCO vivo: `protected=true`; si cerrada: P&L real desde fills;
  si sin OCO: re-protege o aplana. Cierra la **precondición dura I1** (doble-compra por fill incierto).
  (2) **Monitor de cierres reales** (`src/lib/monitor/monitor-real.ts`, `runMonitorTickReal`): detecta
  fill server-side del OCO por polling REST; cierre **close-first idempotente** (cierra posición en DB
  antes de insertar fill → protege ante doble tick); calcula P&L desde fills reales; handoff M3 al
  reconciler si el OCO muere. (3) **Frescura OHLCV** (`src/lib/market-data/refresh.ts`): job repetible
  (cadencia 1 min, configurable `OHLCV_REFRESH_INTERVAL_MS`) que mantiene `ohlcv_candles` al día con
  cliente ccxt público. (4) **Gate setup-aware** (`isSetupOccupied`, `src/lib/execution/setup-occupied.ts`):
  cuenta entradas sin resolver (`pending`/`pending_execution`) como ocupado, además de posición abierta —
  cierra I1 **por seguridad**, independiente de la cadencia del reconciler. (5) **`clientOrderId`
  determinista** (= `signalId`) en `placeEntry`, que habilita la búsqueda de entradas inciertas por ccxt.
  El LLM **sigue en sombra**. Suite **381/381** verde. El **smoke vigilado en testnet** (valida las
  llamadas ccxt reales: `fetchOrder` por `clientOrderId`, `fetchOrderTrades`, cierre con P&L real, frescura
  de `ohlcv_candles`) queda **owner-gated, pendiente**. Plan en
  `docs/superpowers/plans/2026-06-29-sp13-reconciler-monitor-ccxt.md`.
  **🎉 FASE 3 COMPLETA EN CÓDIGO.** El loop testnet continuo desatendido puede habilitarse tras
  el smoke vigilado. Queda: SP14 (`/cierra`, `/modo`), trailing (sprint propio), Fase 4 (live).

> Pendientes antes del **loop testnet continuo**: únicamente el **smoke vigilado owner-gated de SP13**
> (valida llamadas ccxt reales contra Binance testnet). Todo lo demás de Fase 3 está implementado.
> Luego SP14 (`/cierra` y `/modo`) y trailing (sprint propio). Hecho en SP13: reconciler ccxt, monitor
> real close-first, frescura OHLCV, gate setup-aware, clientOrderId determinista.

> Nota: `evaluate-candidate` es una **función de orquestación** dirigida por código (no
> `defineWorkflow` descubierto) — el camino del dinero es determinista, no un workflow LLM. Vive en
> **`src/orchestration/evaluate-candidate.ts`** (NO en `src/workflows/`): Flue **descubre como
> workflow/canal/agente TODO `.ts` plano** en `src/workflows|channels|agents/`, así que esos
> directorios solo pueden contener módulos descubribles. **Regla:** ni archivos `.test.ts` ni
> funciones que no sean `defineWorkflow`/`channel`/`defineAgent` van planos ahí (los tests de un
> módulo descubierto van en un subdir anidado `__tests__/`, que Flue ignora). Lo destapó el primer
> `flue run` en SP7. Desviación consciente de §12.

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

Flujo central (`orchestration/evaluate-candidate.ts`): scanner detecta setup → encola job →
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
- **Reconciliación exchange↔DB al arranque** antes de que el scanner dispare (`runExchangeReconcile`, SP13, modo real).
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

**Dónde estamos:** Fases 1, 2 y **3 (en código) completas**. **SP13 cierra Fase 3 en código**: el
reconciler ccxt, monitor real, frescura OHLCV y gate setup-aware están implementados y testados
(suite **381/381**). El LLM **sigue en sombra**. **Pendiente inmediato (owner-gated):** el **smoke
vigilado de SP13** — correr contra Binance testnet para confirmar `fetchOrder` por `clientOrderId`,
fills reales, P&L, re-protección del OCO y frescura de `ohlcv_candles`; hasta correrlo, el loop
testnet continuo desatendido no se habilita. **Luego:** SP14 (`/cierra`, `/modo` — control que
toca dinero), trailing (sprint propio) y Fase 4 (**live**, poco capital).
