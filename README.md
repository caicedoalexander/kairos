# Kairos

> Bot de trading de cripto **autónomo** con agentes de IA, sobre **Flue 1.0**.

**Estado:** 🧭 Fase de diseño. La arquitectura está definida en [`ARCHITECTURE.md`](./ARCHITECTURE.md); aún no hay implementación.

> ⚠️ **Aviso de riesgo.** Kairos ejecuta operaciones de forma autónoma (sin aprobación humana por trade). El trading de cripto conlleva riesgo de pérdida total. El sistema arranca y se valida en modo `sim` y `testnet`; pasar a `live` es decisión y responsabilidad del operador. Empieza con poco capital.

---

## Qué es

Kairos separa el **juicio** de la **ejecución**: un scanner determinista barato filtra el mercado en cada tick; cuando dispara un setup, agentes LLM razonan y emiten un **veredicto explícito**; y código determinista e idempotente lo verifica contra límites de riesgo duros y ejecuta la orden.

**Principio rector:** *el LLM tiene juicio, no gatillo.* Los modelos solo **miran** y **proponen**; mover dinero es siempre código auditable, nunca una tool en manos del modelo.

## Stack

| Capa | Tecnología |
|---|---|
| Framework de agentes | Flue 1.0 (Node target, Docker) |
| Lenguaje | TypeScript (tools) + Markdown (skills/doctrina) |
| Exchange | Binance (Spot long-only, vía `ccxt`) — sim → testnet → live |
| Estado | PostgreSQL (store de Flue + dominio) |
| Coordinación | Redis (cache, locks, BullMQ) |
| Notificación/control | WhatsApp vía Evolution API (canal custom) |
| Infra | VPS con Docker |

## Arquitectura en una imagen

```
Scheduler (BullMQ) ──tick──> Scanner (determinista, sin LLM)
                                 │ candidato → señal + encola evaluación
                                 ▼
                    Workflow evaluate-candidate
                       ├─ decision-maker (Sonnet → Opus)   razona y propone
                       │   ├─ analista técnico (Haiku)       subagente
                       │   └─ analista fundamental (Haiku)    subagente
                       ├─ check_risk        (determinista)  límites duros
                       ├─ execute_order     (determinista)  idempotente, ccxt
                       └─ notify (template) ─────────────►  WhatsApp

WhatsApp in (Evolution) → canal custom → control: /estado /pausa /cierra
```

Tres capas: **determinista** (scanner, risk gate, executor), **razonamiento** (3 agentes LLM), **notificación** (template, sin LLM). Detalle completo en [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Estructura del proyecto (objetivo)

```
kairos/
├─ ARCHITECTURE.md          # diseño completo (fuente de verdad)
├─ .env.example             # plantilla de configuración
├─ src/
│  ├─ agents/               # control.ts (sesión de comandos WhatsApp)
│  ├─ workflows/            # evaluate-candidate.ts (decisión+riesgo+ejecución)
│  ├─ channels/             # evolution.ts (WhatsApp inbound)
│  ├─ subagents/            # technical-analyst, fundamental-analyst
│  ├─ tools/                # market-data, indicators, fundamental, account
│  ├─ lib/                  # núcleo determinista (scanner, risk, execution, paper-sim)
│  ├─ db/                   # repositorios de dominio + schema
│  ├─ skills/               # doctrina: decision-protocol, technical-read, ...
│  └─ db.ts                 # adapter postgres() → store de Flue
└─ .claude/agents/          # revisores a medida (diseño, plan, implementación)
```

## Arranque local (Fase 0)

El andamiaje de Fase 0 (infra, esquema de dominio, ccxt, canal Evolution) ya está implementado y testeable sin ningún agente ni workflow:

```bash
docker compose up -d       # levanta Postgres 16 + Redis 7
npm install
cp .env.example .env       # rellena DATABASE_URL y variables mínimas
npm run migrate            # aplica el esquema kairos (idempotente)
npm test                   # suite verde, cobertura ≥ 80 %
```

> **`flue dev` / `flue build`, el boot del server (`/health`, tablas `flue_*`) y el `Dockerfile` llegan en Fase 1**, cuando exista el primer workflow real. Flue exige ≥ 1 agente o workflow para compilar; Fase 0 no tiene ninguno por diseño.

## Puesta en marcha (planeada)

1. **Provisiona los prerequisitos** (ver `.env.example`):
   - Claves de Binance testnet, Anthropic, Evolution API, y datos fundamentales (tiers gratis).
   - En el VPS: una base PostgreSQL para Kairos y un Redis `noeviction` dedicado para BullMQ.
2. `cp .env.example .env` y rellena los valores.
3. *(Tras la implementación)* `npm install`, migraciones, y `flue dev` para correr el Node target localmente.

## Roadmap

| Fase | Contenido |
|---|---|
| 0 | Andamiaje (proyecto Flue, db.ts, esquema, ccxt, canal Evolution) |
| 1 | Loop determinista en modo `sim`, sin LLM (valida el pipeline sin gastar en modelos) |
| 2 | Razonamiento: decision-maker + analistas + skills de doctrina (sigue en `sim`) |
| 3 | Binance **testnet** (valida el plumbing real de órdenes) |
| 4 | **Live** con poco capital, guardrails al máximo |
| 5 | Dashboard en tiempo real *(fuera de alcance del diseño actual)* |

## Modelo de seguridad

- El LLM **nunca** tiene tools de mutación; ejecuta código determinista tras el risk gate.
- Límites duros en código: tamaño máx., exposición, pérdida diaria, drawdown, kill-switch.
- Toda orden con **clave de idempotencia** (`UNIQUE` en DB) — reintentar nunca duplica.
- SL/TP duro determinista e inmediato; no depende de una llamada LLM.
- Credenciales del exchange en *closures*, jamás en el input que elige el modelo.
- Modos `sim`/`testnet`/`live` explícitos; nada toca dinero real sin el flag.

## Herramientas de desarrollo

- **Agentes revisores** (`.claude/agents/`): `kairos-design-reviewer`, `kairos-plan-reviewer`, `kairos-implementation-reviewer` — verifican uso correcto de Flue y las líneas rojas del proyecto contra la documentación real.
- **Skills**: `ccxt-typescript` (uso de ccxt) y `llm-trading-agent-security` (seguridad de agentes de trading).

## Documentación

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — diseño completo: agentes, flujos, skills, tools, estado, modelos, ejecución y riesgos.
