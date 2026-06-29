# Pendientes — tras cerrar Fase 2 (sombra)

> Estado: **Fase 2 COMPLETA en `sim`/sombra** (SP7→SP11). El loop razona end-to-end —
> decision-maker LLM + analista técnico + analista fundamental condicional + escalación Sonnet→Opus +
> risk-policy + medición A/B + control WhatsApp inbound — todo **sin tocar dinero** (el LLM juzga, el
> código determinista ejecuta). Siguiente hito: **testnet**.
>
> Fecha de corte: 2026-06-29. `main` está **97 commits por delante de `origin`** (sin push).

---

## 1. Acción inmediata (tú decides)

### 1.1 Variables de entorno (`.env`)

| Variable | Estado | Acción |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ poblada (smokes funcionaron) | — |
| `DATABASE_URL`, `REDIS_URL` | ✅ pobladas | — |
| **`CRYPTOPANIC_API_KEY`** | ⚠️ **vacía** | **Poblar** para activar el camino de noticias del analista fundamental. Hoy el fetch degrada a `[]` y el gate solo abre por **derivados extremos**; con la key, también por catalizadores. Free tier basta. |
| `ESCALATION_MODEL` | no seteada → default `anthropic/claude-opus-4-6` | El default **resolvió** en el smoke (Opus corrió). Si el catálogo de Pi cambia el id de Opus, override aquí (confirmar con `flue dev`). |
| `CONTROL_MODEL` | no seteada → default `anthropic/claude-haiku-4-5` | Opcional. |
| `DECISION_MODEL` / `TECHNICAL_MODEL` / `FUNDAMENTAL_MODEL` | defaults razonables (Sonnet/Haiku) | Opcional. |
| `LUNARCRUSH_API_KEY` | comentada (fuente diferida) | Solo si/ cuando se añada el sentimiento social (no implementado; ver §3). |
| **Evolution** (`EVOLUTION_API_URL/KEY/INSTANCE`, `WHATSAPP_CONTROL_NUMBER`, `EVOLUTION_WEBHOOK_SECRET`) | requeridas para WhatsApp | **Poblar** para el smoke end-to-end de SP11 (mensajes reales) y para que el bot **responda** por WhatsApp (notify + control). Sin esto, el control funciona pero las respuestas salientes fallan (best-effort, no rompe). |

### 1.2 Smokes vivos owner-gated (pendientes)

- **SP11 end-to-end real:** envía `/estado` y un texto libre ("¿cómo va?") desde tu número de control
  por WhatsApp (con Evolution vivo + webhook registrado) y verifica la respuesta. *Validado por ahora
  solo vía `flue run control-maker`* (clasificación LLM + kill-switch confirmados); falta el roundtrip
  Evolution→webhook→respuesta.
- **SP7 shadow worker end-to-end** (cola `shadow-eval` viva): el decision-maker se validó con `flue run`;
  el flujo completo `scan-tick → evaluate-worker → enqueue shadow → shadow-worker → invoke` no se corrió
  end-to-end en vivo (cuesta el primer gasto continuo). Opcional antes de testnet.

### 1.3 Push a `origin`

`main` acumula **97 commits** (SP9+SP10+SP11 + docs). Solo lo subo **cuando lo pidas explícitamente**.

---

## 2. Diferido a **testnet** (decisión consciente, no deuda silenciosa)

Estos ítems necesitan el plumbing de órdenes real (no `sim`) y guardrails de modo; van con el salto a
testnet, no antes:

- **OCO residente en el exchange** (SL/TP inmediato real, no polling por cierre de vela).
- **Lock Redis por candidato** (claim antes de tocar el exchange, §273).
- **Reconciler con `fetch` de ccxt** (diff exchange↔DB real al arranque).
- **Mantener `kairos.ohlcv_candles` al día** (cadencia de backfill ≤ `MONITOR_INTERVAL_MS`).
- **Comandos de control que tocan dinero** (SP11 los difirió): `/cierra <symbol>` (`close_position`
  idempotente) y `/modo <sim|testnet|live>` (conmuta modo, muy sensible — podría ir a live). Se añaden
  al picklist `ControlIntent` + un handler determinista cuando exista el plumbing real.
- **Kill-switch con copia caliente en Redis** (`kairos:killswitch`, ARCHITECTURE §276): hoy `bot_state`
  vive solo en Postgres (suficiente en `sim`, un proceso). En testnet, si scanner y control corren en
  procesos distintos, la copia Redis reduce latencia.
- **Dedup de mensajes inbound** del control (idempotencia por `key.id`): hoy aceptado (los comandos son
  idempotentes); una redelivery de Evolution re-invoca el LLM y re-responde (costo, no dinero).

---

## 3. Fuera de alcance de Fase 2 (futuro, YAGNI)

- **Analista fundamental — fuentes adicionales:** LunarCrush (sentimiento social) y on-chain
  (Glassnode/Santiment, de pago). SP9 entregó CryptoPanic (noticias) + posicionamiento (funding/OI).
- **Circuit-breaker / `pending_approvals`** (aprobación humana por trade vía WhatsApp): opcional, default
  OFF (el owner eligió autonomía total). No implementado.
- **Dashboard del A/B:** SP10 entregó el reporte como CLI (`npm run shadow-report`); un dashboard es
  upgrade futuro.
- **Que el LLM ejecute el camino del dinero:** decisión post-A/B (cuando los datos de sombra muestren
  edge). Hoy el dinero (sim) ejecuta **siempre** el veredicto determinista; el LLM corre en sombra.

---

## 4. Deuda menor (registro, no bloquea nada)

Minors diferidos durante la implementación (en los ledgers `.superpowers/sdd/`), candidatos a un
cleanup cuando se toque el área:

- **SP10:** `fundamental_status`/`FundamentalOutcome.status` tipados `string` en vez de union literal
  (atraparía typos cuando SP-futuro consuma el A/B); cobertura de `confianzaDist`/`avgSizing*` en
  `computeShadowReport` (lógica de presentación, sin aserción).
- **SP11:** tests que podrían afirmar más args (`fromMe` lee env en construcción; free-text no afirma
  args de `invoke`) — in-spec, polish.
- **SP9:** `ShadowVerdictRow.technicalRead` tipado `unknown|null` (inalcanzable desde callers tipados).
- **General:** `verifyEvolutionWebhook` compara el secreto con `===` no-constant-time (pre-existente,
  bajo riesgo sobre HTTPS).

---

## 5. Cómo medir el edge (cuando haya datos de sombra)

Con el loop corriendo en `sim`, los veredictos LLM se acumulan en `kairos.shadow_verdicts` junto a los
deterministas en `kairos.decisions`. Para ver si el LLM aporta edge:

```bash
npm run shadow-report
```

Reporta acuerdo de acción (4 cuadrantes), tasa de escalación a Opus, y el `sizingEdge` (P&L ponderado
por sizing sobre posiciones cerradas — **acotado**: mide solo la dimensión de sizing, no la divergencia
SL/TP del LLM). Cuanto más tiempo corra el loop en sim, más significativo el A/B.
