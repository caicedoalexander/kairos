# Pendientes — tras cerrar Fase 3 en código (trailing incluido)

> Estado: **Fases 1, 2 y 3 COMPLETAS EN CÓDIGO** (SP7→SP14 + trailing). El loop razona end-to-end,
> el ejecutor real + reconciler ccxt + monitor real + frescura OHLCV + comandos `/cierra`/`/modo` +
> **trailing stop determinista** están implementados y testados (suite 432/432). El LLM sigue en
> sombra. **Pendiente inmediato:** smokes vigilados owner-gated de SP13, SP14 y trailing. Luego
> Fase 4 (live).
>
> Fecha de corte: 2026-06-30. `trailing-stop` está adelantado de `main`; `main` está
> **varios commits por delante de `origin`** (sin push).

---

## 1. Acción inmediata (tú decides)

### 1.1 Variables de entorno (`.env`)

| Variable | Estado | Acción |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ poblada (smokes funcionaron) | — |
| `DATABASE_URL`, `REDIS_URL` | ✅ pobladas | — |
| `NEWS_RSS_URL` | ✅ default funciona (CoinTelegraph RSS, sin key) | Opcional. El analista fundamental ya recibe noticias **out-of-the-box** vía RSS (`src/lib/sources/news.ts`). Override solo si quieres otro feed. *(Se migró desde CryptoPanic: su free tier se discontinuó el 2026-04-01.)* |
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
- **SP13 reconciler/monitor ccxt** (bloqueante para loop continuo): con `KAIROS_MODE=testnet` y el worker
  vivo, verificar contra Binance testnet real: (H3) `fetchOrder(undefined, symbol, { clientOrderId })` recupera
  la entrada por signalId; reconciler re-protege una posición `protected=false`; monitor detecta fill del
  OCO y cierra con P&L real; `ohlcv_candles.max(open_time)` avanza sin intervención.
  **[I-1] Verificar la moneda del fee de compra en testnet:** si el fee se cobra en base (BTC), el
  re-protect del reconciler usa qty bruta (`state.filled`) y podría fallar por saldo insuficiente,
  dejando la posición `protected=false` → corregir restando `feeBase` (igual que el executor real en
  `execute-order-real.ts:78`) ANTES de habilitar el loop continuo / antes de live.
  Sin este smoke, el loop testnet continuo desatendido **no debe habilitarse**.
- **SP14 `/cierra` real** (bloqueante para usar el comando en testnet): con `KAIROS_MODE=testnet` y
  una posición abierta real, enviar `/cierra BTC/USDT` por WhatsApp → verificar: (a) el OCO desaparece
  del exchange (cancelado por leg vía `cancelOrder`); (b) la venta market IOC ejecuta; (c) la posición
  queda `status='closed'` en DB con P&L real calculado desde fills; (d) si se repite el comando → "ya
  estaba cerrada" (idempotencia). Hasta correr este smoke, `/cierra` en testnet no se usa en producción.
  **Nota antes de live — riesgo de over-sell (deuda declarada):** `/cierra` (y `emergencyClose`) venden
  `pos.size` por market; en una cuenta con balance base LIBRE compartido (live), la venta podría tocar
  saldo ajeno a la posición (p.ej. saldo libre del mismo activo u otra posición larga). En testnet
  (cuenta dedicada) el rechazo `InsufficientFunds` es el backstop suficiente. Antes de live: usar
  cuenta/sub-cuenta dedicada por estrategia, o derivar la qty a vender del balance reservado por el OCO
  en vez de `pos.size` crudo.
- **Trailing stop** (bloqueante para usar el trailing en testnet): con `KAIROS_MODE=testnet`,
  `risk_params.trailing` poblado en la estrategia, y una posición en ganancia activa, verificar:
  (a) el monitor detecta que el precio supera el umbral de trail (`pct`); (b) el OCO antiguo
  desaparece del exchange (cancelado correctamente — todos los ids de cada leg); (c) aparece un OCO
  nuevo con SL más alto que el anterior; (d) no hay doble OCO ni venta de emergencia; (e) si el
  precio retrocede, el SL no baja (ratchet); (f) simular/observar un crash entre la recolocación
  del OCO y la persistencia deja la posición **re-protegida sin doble-OCO persistente** (el
  handoff M3 + reconciler A.2 la cubren; nunca naked; el SL nunca baja — deuda de crash-safety
  acotada y testnet-aceptable). Hasta correr este smoke, el trailing en testnet no se usa en producción.

### 1.3 Push a `origin`

`main` acumula **97 commits** (SP9+SP10+SP11 + docs). Solo lo subo **cuando lo pidas explícitamente**.

---

## 2. Diferido a **testnet** — estado post-SP13

Los siguientes ítems han sido implementados en testnet (SP12+SP13) y **ya no son deuda**:

- ✅ **OCO residente en el exchange** — SP12.
- ✅ **Lock Redis por candidato** — SP12 (`withSetupLock`).
- ✅ **Reconciler con `fetch` de ccxt** — SP13 (`runExchangeReconcile`, A.1 + A.2).
- ✅ **Mantener `kairos.ohlcv_candles` al día** — SP13 (`src/lib/market-data/refresh.ts`, job 1 min).
- ✅ **Gate setup-aware** (cierra I1 por seguridad) — SP13 (`isSetupOccupied`).
- ✅ **`clientOrderId` determinista** para entradas inciertas — SP13.
- ✅ **Monitor de cierres reales** (close-first idempotente, P&L de fills reales) — SP13.

**Pendientes aún diferidos:**

- ✅ **`/cierra <symbol>`** — implementado en SP14 (cancel-first, idempotente, falla cerrado,
  schema estricto excluye cierra del LLM). Smoke owner-gated pendiente (ver §1.2).
- ✅ **`/modo`** — implementado en SP14 (read-only, reporta el modo actual).
- ✅ **Trailing stop** — implementado en el sprint de trailing (determinista, opt-in por
  `risk_params.trailing`, precio fresco, ratchet, cancel-todos, persistir-después, crash-safe).
  Smoke owner-gated pendiente (ver §1.2).
- **Conmutación de modo en caliente** (`/modo <sim|testnet|live>`) — sprint propio (muy sensible;
  `/modo` solo reporta el modo actual en SP14).
- **Kill-switch con copia caliente en Redis** (`kairos:killswitch`, ARCHITECTURE §276): hoy `bot_state`
  vive solo en Postgres (suficiente para un proceso). En testnet con procesos separados, la copia Redis
  reduce latencia — candidato a sprint de limpieza.
- **Dedup de mensajes inbound** del control (idempotencia por `key.id`): hoy aceptado (los comandos son
  idempotentes); una redelivery de Evolution re-invoca el LLM y re-responde (costo, no dinero) — candidato a sprint de limpieza.

---

## 3. Fuera de alcance de Fase 2 (futuro, YAGNI)

- **Analista fundamental — fuentes adicionales:** LunarCrush (sentimiento social) y on-chain
  (Glassnode/Santiment, de pago). SP9 entregó **noticias por RSS** + posicionamiento (funding/OI).
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
