# Kairos — Arquitectura

> Sistema de trading algorítmico autónomo con agentes de IA, construido sobre **Flue 1.0**.
> Documento de diseño. Primera nota del proyecto. Fecha: 2026-06-24.

---

## 1. Resumen ejecutivo

Kairos es un bot de trading de cripto **autónomo**: un *scanner determinista barato* filtra el mercado en cada tick; cuando dispara un setup, **tres agentes LLM** (un decision-maker + dos analistas) razonan y emiten un veredicto explícito; **código determinista e idempotente** verifica ese veredicto contra límites de riesgo duros y ejecuta la orden vía `ccxt`; WhatsApp notifica el razonamiento y permite controlar el bot.

El principio rector: **el LLM tiene juicio, no gatillo.** Los modelos solo *miran* y *proponen*; mover dinero es siempre código auditable.

Corre como **servicio Node siempre-activo en Docker sobre el VPS**, con **PostgreSQL** como estado (de Flue y de dominio) y **Redis** como coordinación.

---

## 2. Decisiones de diseño fijadas

| Decisión | Elección | Razón |
|---|---|---|
| Topología | **Flue Node target en Docker sobre el VPS** | Cloudflare Workers no admite loops continuos/sockets ni acepta Postgres como store de Flue. |
| Cadencia | **Intradía 5m–1h** (polling REST, sin websockets) | Costo LLM controlable, plumbing simple para validar el pipeline. |
| Rol del LLM | **Juzga candidatos pre-filtrados** por código | Barato, reproducible, auditable. El 95% de los ticks no invocan LLM. |
| Autonomía | **Total**: filtros pasan → ejecuta automático, sin aprobación humana | Decisión explícita del owner. Mitigada por guardrails deterministas (ver §11). |
| Exchange | **Binance** (testnet Spot + datos reales de prod para sim) | Mayor soporte ccxt, testnet gratis, máxima liquidez. |
| Mercado | **Spot, long-only** (fase paper) | Sin apalancamiento/liquidación/funding. Mínimo riesgo al auditar autonomía. Futures es fase posterior. |
| Estrategias | **Agnóstico**: doctrina como skills, estrategias como config | Kairos es plataforma, no un bot atado a una estrategia. |

---

## 3. Restricciones del framework (Flue) que moldearon el diseño

Hallazgos de la documentación real de Flue (`@flue/runtime` beta.5) que cambiaron el diseño ingenuo:

1. **Cloudflare Workers no puede correr el loop.** Sin `while(true)`, sin websockets persistentes, cron mínimo 1 min, y Flue obliga a Durable Object SQLite (no tu Postgres). → El cerebro vive en el **Node target del VPS**.
2. **Evolution API es incompatible con el canal nativo `@flue/whatsapp`** (que solo habla WhatsApp Cloud API de Meta, con firma `X-Hub-Signature-256`). → Se construye un **canal custom** + tool de salida al REST de Evolution.
3. **Flue no persiste datos de dominio.** Su store guarda solo sesiones/runs/eventos. Posiciones, señales, P&L y config → **esquema propio** en Postgres.
4. **No hay RPC agente-a-agente.** La orquestación se hace con **subagentes** (delegación in-process vía `session.task`) y **workflows** (dirigidos por código), no una malla de procesos.
5. **La idempotencia es responsabilidad de la app.** Los canales no deduplican; Flue solo reintenta cuando la seguridad de replay es *demostrable*, y termina como fallido lo incierto. → Toda ejecución lleva clave de idempotencia.
6. **Node no auto-termina workflow runs interrumpidos** (quedan `active`). → Se usa **BullMQ** como espina durable de la cola/scheduler (retries, stalled jobs), con ejecución idempotente.

---

## 4. Arquitectura de componentes (3 capas)

### Capa 1 — Determinista (SIN LLM)

| Componente | Forma en Flue | Responsabilidad |
|---|---|---|
| **Scanner / motor de señales** | Job BullMQ + tools puras | Cada N min: `fetch_ohlcv` → calcula indicadores → aplica reglas de la estrategia. Si dispara, escribe `signals` y encola evaluación. |
| **Risk gate** | Función `check_risk` | Límites duros NO negociables: tamaño máx., exposición, pérdida diaria, drawdown, kill-switch, circuit-breaker opcional. Devuelve `allow`/`deny`/`needs_approval`. |
| **Executor** | Función `execute_order` (ccxt) | Coloca la orden con clave de idempotencia, modo `sim`/`testnet`/`live`. Solo tras pasar el risk gate. |
| **Position monitor** | Job BullMQ | Vigila SL/TP, señales de salida, reconciliación de llenados. |
| **Reconciler** | Job de arranque | Compara `positions` (DB) vs exchange real antes de arrancar el scanner. |

### Capa 2 — Razonamiento (LLM)

| Agente | Forma en Flue | Responsabilidad | Modelo |
|---|---|---|---|
| **Decision-maker** | Workflow `evaluate-candidate` (su agente con `subagents`) | Carga el skill de doctrina, delega a los analistas, sintetiza, emite **veredicto estructurado** (Valibot). No ejecuta: propone. | Sonnet 4.6 → Opus en escalación |
| **Analista técnico** | Subagente (profile en `subagents:[]`) | Interpreta los indicadores ya calculados. Solo lectura. | Haiku 4.5 |
| **Analista fundamental** | Subagente | Trae y pesa noticias/sentimiento/on-chain. Solo lectura. | Haiku 4.5 |
| **Control** | Agente continuo (`agents/control.ts`) | Interpreta comandos de WhatsApp (`/estado`, `/pausa`, `/cierra`). | Haiku 4.5 |

### Capa 3 — Notificación (sin agente LLM)

El mensaje de WhatsApp se **renderiza por template** desde el registro de decisión (determinista, sin alucinación). Solo el *inbound* de control reabre una sesión LLM.

### Comunicación (no hay RPC agente-a-agente)

```
Scheduler (BullMQ) ──tick──> Scanner (determinista)
                                 │ candidato → INSERT signals + encola job
                                 ▼
                    Workflow evaluate-candidate
                       ├─ session.skill(decision-protocol)   ← razonamiento
                       │     ├─ task(technical-analyst)        ← subagente aislado
                       │     └─ task(fundamental-analyst)       ← subagente aislado
                       │  → veredicto estructurado (Valibot)
                       ├─ check_risk(veredicto)                ← determinista
                       ├─ allow → execute_order(idempotencyKey)← determinista
                       └─ notify (template)                    ← WhatsApp out

WhatsApp in (Evolution) → canal custom → dispatch(control) → comandos seguros
```

---

## 5. Flujos

### Flujo A — Entrada autónoma

1. **Scanner** (cada 5–15 min/estrategia·símbolo): `fetch_ohlcv` → indicadores → reglas. Sin setup → fin (gratis). Con setup → claim idempotente (lock Redis) → `INSERT signals` → encola `evaluate-candidate`.
2. **Decision-maker**: carga skill de la estrategia → `task(technical-analyst)` + `task(fundamental-analyst)` → síntesis → veredicto `{accion, lado, confianza, sizing_factor, sl, tp, razonamiento}`.
3. **Risk gate** (`check_risk`): el filtro final. `deny` → registra y notifica. `allow` → continúa. `needs_approval` → solo si el circuit-breaker está ON (default OFF).
4. **Executor** (`execute_order`): `idempotency_key = signalId` → coloca orden + SL/TP → `UPSERT positions`, `INSERT orders/fills`, `audit_log`.
5. **Notify**: template WhatsApp con entrada + razonamiento.

### Puntos de decisión

| # | Dónde | Quién | Tipo |
|---|---|---|---|
| 1 | ¿Hay setup? | Scanner | Determinista |
| 2 | ¿Entrar o ignorar? | Decision-maker | **LLM (juicio)** |
| 3 | ¿Pasa límites de riesgo? | Risk gate | Determinista (no negociable) |
| 4 | ¿Circuit-breaker? (opcional) | Risk gate + humano | Híbrido, default OFF |
| 5 | ¿Orden llenó/falló? | Executor | Determinista + reintento idempotente |

### Flujo B — Gestión de salida

El **position monitor** corre en el mismo scheduler por cada posición abierta:
- **SL/TP duro tocado** → cierre **inmediato y determinista** (nunca esperas al LLM para cortar pérdidas), reconcilia, calcula P&L, notifica.
- **Señal de salida de la estrategia (reglas)** → encola decisión → el LLM decide cerrar / mover SL (trailing) / mantener.
- **Timeout de tesis** (p. ej. 24h sin moverse) → re-evaluar.

### Flujo C — Canal de control (WhatsApp inbound)

```
Humano → Evolution API → canal custom Flue (valida firma) → dispatch(control)
   /estado     → resume posiciones, P&L, exposición (template)
   /pausa      → kill-switch ON (scanner deja de disparar)
   /reanuda    → kill-switch OFF
   /cierra BTC → close_position (idempotente)
   /modo X     → conmuta sim/testnet/live
   (texto)     → LLM interpreta intención → comando seguro
```

### Manejo de errores y casos límite

- **Idempotencia**: `UNIQUE(idempotency_key)` en `orders` + claim en Redis antes de actuar. Reintento de BullMQ/Flue nunca duplica.
- **Llenado parcial**: `orders.status = partial` → el monitor reconcilia hasta `filled`/`canceled`; el sizing real sale de los `fills`.
- **Exchange caído / rate-limit**: la tool ccxt reintenta con backoff; si falla, la decisión queda `pending_execution` y se notifica — **nunca** se asume ejecutada.
- **Crash a mitad de decisión**: BullMQ recupera el job (stalled); idempotencia hace seguro reintentar. Las Actions/órdenes completadas no se re-ejecutan.
- **Reconciliación al arranque**: `positions` (DB) vs exchange real → corrige desviaciones → registra en `audit_log` → recién entonces arranca el scanner.

---

## 6. Skills (Markdown)

Los skills **guían el razonamiento; no añaden capacidad ejecutable**. Dos tipos:

### Skills de doctrina (genéricos) — necesarios

| Skill | Para | Encapsula |
|---|---|---|
| `decision-protocol` | Decision-maker | Cómo sintetizar evidencia + **contrato de salida** del veredicto (Valibot) |
| `technical-read` | Subagente técnico | Cómo interpretar indicadores (confluencia, divergencia, régimen) |
| `fundamental-read` | Subagente fundamental | Separar catalizador de ruido, decaimiento temporal de noticias |
| `risk-policy` | Decision-maker | Doctrina cualitativa de cautela/sizing (los límites duros van en código) |

### Skills de estrategia (específicos) — opcionales

Una estrategia es **config declarativa en Postgres** (trigger + skip conditions + sizing), consumida por el `decision-protocol` genérico. El skill por-estrategia es un *escape hatch* solo para matices de juicio difíciles de parametrizar.

```
src/skills/
├─ decision-protocol/SKILL.md   ← necesario
├─ technical-read/SKILL.md      ← necesario
├─ fundamental-read/SKILL.md    ← necesario
├─ risk-policy/SKILL.md         ← necesario
└─ strategies/                  ← slot opcional, vacío al inicio
```

### Frontmatter (validado por Flue contra la spec de Agent Skills)

`name` (required, lowercase-hyphen, = nombre del directorio, ≤64), `description` (required, ≤1024). Opcionales: `license`, `compatibility`, `metadata` (map string→string), `allowed-tools` (aceptado, no forzado).

### Salida estructurada

El veredicto no es prosa libre: se invoca con `result` (Valibot) para forzar JSON validado.

```ts
const verdict = await session.skill('decision-protocol', {
  args: { signal, technical, fundamental, strategyConfig },
  result: v.object({
    accion: v.picklist(['enter', 'skip']),
    lado: v.picklist(['long']),        // spot long-only; 'short' se añade con futures
    confianza: v.picklist(['alta', 'media', 'baja']),
    sizing_factor: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    sl: v.number(), tp: v.number(),
    razonamiento: v.string(),
  }),
});
```

---

## 7. Tools (TypeScript)

> **Línea roja de seguridad:** los agentes de razonamiento solo tienen tools de **lectura**. La mutación (ejecutar/cerrar/cancelar) **NO está en el toolset de ningún modelo** — la ejecutan funciones deterministas tras el veredicto. El bucle de tool-calling del LLM nunca dispara una orden.

### Nivel lectura (`defineTool`, van en `tools:[]`)

| Tool | input → output | Lo usa | Reusa |
|---|---|---|---|
| `fetch_ohlcv` | `{symbol, timeframe, limit}` → `{candles[]}` | Scanner, técnico | ccxt |
| `fetch_ticker` | `{symbol}` → `{last, bid, ask}` | Scanner, técnico | ccxt |
| `fetch_order_book` | `{symbol, depth}` → `{bids, asks}` | Técnico | ccxt |
| `calculate_rsi/ema/macd` | `{candles, period}` → `{values[]}` | Scanner; técnico | `technicalindicators` npm |
| `find_support_resistance` | `{candles}` → `{levels[]}` | Scanner; técnico | propio |
| `fetch_news` | `{symbol, since}` → `{items[]}` | Fundamental | API/MCP |
| `get_sentiment` | `{symbol}` → `{score, sources[]}` | Fundamental | API/MCP |
| `fetch_onchain_metrics` | `{asset}` → `{flows, activeAddr,...}` | Fundamental | API/MCP |
| `get_open_positions` | `{}` → `{positions[]}` | Decision-maker, control | DB |
| `get_account_balance` | `{}` → `{balances[]}` | Decision-maker | ccxt (cred. en closure) |
| `get_exposure` | `{}` → `{netExposure, byAsset, corr}` | Decision-maker | DB |
| `get_order_status` | `{orderId}` → `{status, filled}` | Monitor, control | ccxt |

### Nivel control/mutación (funciones deterministas, NUNCA en un modelo)

`check_risk` (evalúa, no muta), `execute_order`, `set_stop_take`, `close_position`, `cancel_order`. Todas con I/O validado; las que mutan llevan idempotencia.

### IO

`send_whatsapp` (outbound al REST de Evolution; usado por el notificador y la respuesta del control).

### Seguridad: credenciales en closures

Las API keys del exchange y el account-id van en **closure** (factory que recibe la identidad del agente), nunca en el `input` elegido por el modelo. El modelo elige `symbol`/`size`; jamás la cuenta ni la key.

---

## 8. Gestión de estado

| Capa | Almacén | Gobierna | Guarda |
|---|---|---|---|
| Runtime | Postgres (`flue_*`) | Flue (`@flue/postgres`) | Sesiones, runs, eventos |
| Dominio | Postgres (esquema `kairos`) | **Tú** | Posiciones, señales, decisiones, órdenes, P&L, config |
| Coordinación | Redis | Tú | Caché, locks, rate-limit, cola (BullMQ), kill-switch caliente |

Una sola base Postgres, dos namespaces. Wiring de Flue:

```ts
// src/db.ts
import { postgres } from '@flue/postgres';
export default postgres(process.env.DATABASE_URL!);
```

### Esquema de dominio (append-first)

| Tabla | Columnas clave | Rol |
|---|---|---|
| `strategies` | `id, enabled, timeframe, symbols[], trigger_config jsonb, risk_params jsonb, skill_name?, version` | Config declarativa (hot-reload) |
| `signals` | `id(ulid), strategy_id, symbol, fired_at, indicator_snapshot jsonb, status` | Historial de señales |
| `decisions` | `id, signal_id, verdict jsonb, reasoning text, technical_read jsonb, fundamental_read jsonb, model_used, tokens` | Razonamiento explícito (append-only) |
| `risk_evaluations` | `id, decision_id, result, reason, adjusted_size, limits_snapshot jsonb` | Auditoría del gate |
| `orders` | `id, idempotency_key UNIQUE, decision_id, side, size, status, exchange_order_id, mode` | Guardia DB contra duplicados |
| `fills` | `id, order_id, price, qty, fee, ts` | Reconciliación de llenados |
| `positions` | `id, symbol, side, entry, size, sl, tp, status, realized_pnl, strategy_id` | Posiciones abiertas (source of truth) |
| `account_snapshots` | `ts, equity, drawdown, daily_pnl` | Límites de pérdida diaria/drawdown |
| `audit_log` | `ts, event_type, actor, payload jsonb` | Rastro completo |

### Redis (coordinación, NO store de Flue)

| Uso | Patrón | Nota |
|---|---|---|
| Caché OHLCV | `ohlcv:{sym}:{tf}` TTL ≈ 1 vela | Evita martillar el exchange |
| Lock por candidato | `SET lock:decision:{sym}:{strat} NX PX` | Un solo evaluador por setup |
| Rate-limit | token bucket por exchange | Respeta límites API |
| Cola/scheduler | **BullMQ** | Cadencia + jobs; sobrevive reinicios + retries |
| Kill-switch caliente | `kairos:killswitch` | Copia rápida; la durable vive en Postgres |

> **Ops:** caché y locks quieren TTL (eviction OK) → el Redis actual sirve. **BullMQ necesita `noeviction`** → DB/instancia Redis dedicada. Esto también tapa el hueco de Node con los workflow runs colgados.

---

## 9. Modelos por agente

| Componente | Modelo | `thinkingLevel` | Por qué |
|---|---|---|---|
| Decision-maker | `anthropic/claude-sonnet-4-6` → **Opus** en escalación | `high` | Juicio que mueve dinero; volumen bajo |
| Analista técnico | `anthropic/claude-haiku-4-5` | `medium` | Interpreta números ya calculados |
| Analista fundamental | `anthropic/claude-haiku-4-5` | `medium` | Recuperación + síntesis |
| Control | `anthropic/claude-haiku-4-5` | `low` | Parseo de intención simple, latencia importa |
| Notificador / Scanner / Risk / Executor | — (sin LLM) | — | Determinista |

> Formato Flue `<provider>/<modelId>`, con override por operación. El id exacto de Opus depende del catálogo de Pi al hacer build — verificar en `flue dev`.

### Escalación a Opus (regla determinista, no la decide el modelo)

`shouldEscalate` = verdadero cuando: notional > X% del equity, **o** primera operación live de una estrategia nueva, **o** (tras pasada Sonnet) confianza = baja, **o** los analistas se contradicen.

### Resiliencia

Flue **no trae failover de modelo**. La orquestación envuelve la llamada y reintenta en un modelo alterno ante error de proveedor (Sonnet→Opus, o secundario vía `registerProvider`).

### Forma del costo por candidato

```
Tick sin setup    → $0            (scanner, ~95% de los casos)
Candidato normal  → 1×Sonnet + ~2×Haiku
Candidato gordo   → 1×Opus   + ~2×Haiku
```
Palancas: fundamental condicional (skip si no hay noticias en la ventana), analistas secuenciales (Haiku rápido, no requiere paralelizar).

---

## 10. Exchange y ejecución (Binance, Spot long-only)

### Tres modos de ejecución (madurez progresiva)

| Modo | Qué hace | Para qué | Costo |
|---|---|---|---|
| **sim** (default) | Llena órdenes contra datos reales de prod, sin tocar el exchange | Medir el *edge* real de la estrategia | Gratis |
| **testnet** | API sandbox de Binance (`ccxt.setSandboxMode(true)`, claves de testnet) | Validar el plumbing real de órdenes | Gratis |
| **live** | Dinero real, poco capital | Producción | Fees ~0.1% taker |

Madurez: **sim** (¿gana?) → **testnet** (¿el código funciona?) → **live**.

### Cómo se calcula el precio del trade

**Live/testnet — lo devuelve el exchange:**
```
order = ccxt.createOrder(symbol, 'market', 'buy', size)
entry = order.average    // VWAP real de llenados — se registra tal cual
fee   = order.fee
```

**Sim — se modela (honesto, o el backtest miente):**
```
book  = fetch_order_book(symbol)
fill  = best_ask * (1 + slippage_bps/10000)   // compra contra el ask
//  mejor: caminar niveles del book hasta cubrir size → VWAP
entry = fill
fee   = size * fill * taker_rate              // restar fees SIEMPRE
```
Regla: en sim asumir precio algo peor que el mid (spread + slippage + fees).

### Sizing (sale del riesgo, no al revés)

```
risk_amount   = equity * risk_per_trade_pct        // p.ej. 1%
stop_distance = |entry - sl|
size          = (risk_amount / stop_distance) * verdict.sizing_factor
notional      = size * entry                        // capado por check_risk
//  spot: notional ≤ balance quote disponible (no se compra lo que no se tiene)
```

### P&L

```
no realizado = (precio_actual - entry) * size - fees
realizado    = (exit - entry) * size - fee_entrada - fee_salida
```
Todo en quote (USDT). Persistido en `positions.realized_pnl` y `account_snapshots`.

> En Spot no hay mark price, funding ni liquidación. Esos entran solo cuando se añada Futures (fase posterior).

---

## 11. Riesgos y mitigaciones

La autonomía total es una decisión explícita del owner. Mitigaciones de ingeniería que la hacen *segura por construcción*:

| Riesgo | Mitigación |
|---|---|
| Veredicto LLM alucinado mueve dinero | El LLM no tiene tools de mutación; ejecuta código determinista tras el risk gate |
| Un solo trade vacía la cuenta | `check_risk`: tamaño máx., exposición, pérdida diaria, drawdown — límites duros en código |
| Órdenes duplicadas tras crash | `idempotency_key` + `UNIQUE` en `orders` + claim en Redis |
| Pérdida sin cortar por caída del LLM | SL/TP duro es determinista e inmediato, no depende de una llamada LLM |
| Estado obsoleto tras downtime | Reconciliación exchange↔DB al arranque |
| Workflow colgado en Node | BullMQ posee liveness/retry; idempotencia hace seguro reintentar |
| Caída del proveedor LLM | Failover en orquestación a modelo alterno |
| Circuit-breaker | `needs_approval` opcional (default OFF) para casos extremos (notional > umbral, anomalía). Cuando está ON, la ejecución se difiere a un registro `pending_approval` resuelto por el canal de control (WhatsApp) — **no** por una pausa de workflow, que Flue no soporta a medio paso |

---

## 12. Estructura de proyecto (Flue Node)

```
kairos/
├─ flue.config.ts
├─ Dockerfile                  # node:22-slim, servicio long-running
├─ .env
├─ src/
│  ├─ app.ts                   # rutas/middleware, health, control webhook
│  ├─ db.ts                    # postgres() → store de Flue
│  ├─ agents/
│  │  └─ control.ts            # sesión de comandos WhatsApp (descubierto)
│  ├─ workflows/
│  │  └─ evaluate-candidate.ts # pipeline decisión+riesgo+ejecución (descubierto)
│  ├─ channels/
│  │  └─ evolution.ts          # canal custom WhatsApp inbound (descubierto)
│  ├─ subagents/               # profiles (importados, no descubiertos)
│  │  ├─ technical-analyst.ts
│  │  └─ fundamental-analyst.ts
│  ├─ tools/                   # importadas: market-data, indicators, fundamental, account
│  ├─ lib/                     # núcleo determinista (NO model-callable)
│  │  ├─ ccxt-client.ts  scanner.ts  rules-engine.ts
│  │  ├─ risk.ts  execution.ts  paper-sim.ts  reconcile.ts  scheduler.ts
│  ├─ db/                      # repositorios de dominio + schema.sql (esquema kairos)
│  ├─ skills/                  # doctrina (importados con `with { type: 'skill' }`)
│  └─ notify/whatsapp.ts       # send_whatsapp + templates
└─ dist/
```

---

## 13. Fases

1. **Fase 0 — Andamiaje**: proyecto Flue, db.ts, esquema de dominio, ccxt-client, canal Evolution + send_whatsapp.
2. **Fase 1 — Loop determinista (sin LLM)**: scanner + reglas + risk gate + executor en modo **sim**, monitor de salida, reconciler. Valida el pipeline end-to-end sin gastar en LLM.
3. **Fase 2 — Razonamiento**: decision-maker + analistas + skills de doctrina. Sigue en **sim** para medir edge.
4. **Fase 3 — Testnet**: conmuta a Binance testnet, valida el plumbing real de órdenes.
5. **Fase 4 — Live** (poco capital): activa guardrails al máximo, observa.
6. **Fase 5 — Dashboard** (fuera de alcance de este diseño): tiempo real, gráficos, posiciones, config visual de estrategias.

---

## 14. Fuera de alcance (por ahora)

- Dashboard en tiempo real (fase 2 del producto).
- Futures / perp / apalancamiento / shorts.
- Múltiples exchanges simultáneos.
- Aprobación humana por trade (se decidió autonomía total; queda el circuit-breaker opcional).
