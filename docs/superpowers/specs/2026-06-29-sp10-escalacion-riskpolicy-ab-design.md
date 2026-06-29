# SP10 — Escalación Sonnet→Opus + skill `risk-policy` + medición A/B (Fase 2, cierre del núcleo)

**Fecha:** 2026-06-29
**Estado:** diseño (decisiones autónomas con criterio documentado; el owner pidió cerrar Fase 2 sin pausas). Pendiente de revisión por `kairos-design-reviewer`.

## Contexto: dónde encaja en Fase 2

| SP | Alcance | Estado |
|---|---|---|
| SP7 | Cimiento LLM + decision-maker en sombra | hecho |
| SP8 | Analista técnico (subagente) + `technical-read` | hecho |
| SP9 | Analista fundamental condicional + `fundamental-read` + CryptoPanic | hecho |
| **SP10 (este)** | **Escalación Sonnet→Opus + `risk-policy` + medición A/B** | — |
| SP11 *(separable)* | Canal de control WhatsApp inbound | — |

SP10 **cierra el núcleo de Fase 2**: completa el razonamiento (escalación + doctrina de riesgo) y entrega
la **medición A/B** que justifica toda la fase sombra — ¿el LLM aporta edge sobre el determinista?
Sigue en **sombra** sobre `sim`: el dinero no se toca.

## Meta

Tres entregables que cierran el razonamiento:

1. **Escalación determinista**: tras la pasada de Sonnet, si el caso es dudoso (confianza baja o
   analistas en contradicción), el **código** (no el modelo) re-evalúa con Opus y usa ese veredicto.
2. **`risk-policy`**: doctrina cualitativa que guía sizing/cautela del decision-maker (los límites
   duros siguen en código).
3. **Medición A/B**: un reporte read-only que compara el veredicto LLM (sombra) contra el determinista
   por señal, incluyendo el edge ponderado por P&L sobre posiciones cerradas.

## Hechos de la API de Flue (reutilizados, ya verificados)

> Verificados contra `node_modules/@flue/runtime/docs/` (skills.md, agent-api.md, subagents.md).

- **Skills compuestos:** los skills registrados en `skills:[]` del agente están **disponibles**
  ("you can trust the agent to use the skills you provide it, as needed", skills.md). El disclosure
  es por `name`/`description`. Así, registrar `risk-policy` junto a `decision-protocol` y que este
  instruya aplicarla es el patrón correcto; el modelo la usa al sintetizar.
- `session.skill(name, { args, result, model })` con `model` override por operación → permite la
  pasada Opus deliberada reusando el mismo skill `decision-protocol`.
- Persistencia de dominio en esquema `kairos` (Flue no la maneja).

## Pieza 1 — Escalación determinista Sonnet→Opus

### Regla (`src/lib/reasoning/escalation.ts`)

```ts
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';

// Escalación = decisión DETERMINISTA (el código, no el modelo). En sombra/sim solo aplican las
// condiciones evaluables sin equity/posición real:
//   - confianza de la pasada Sonnet == 'baja', O
//   - los analistas se contradicen (technical.bias vs fundamental.bias estrictamente opuestos).
// Diferidos a testnet/live (necesitan contexto real): notional > X% equity, primera op live de
// estrategia nueva.
export function shouldEscalate(
  verdict: LlmVerdict, technicalRead: TechnicalRead | null, fundamentalRead: FundamentalRead | null,
): boolean {
  if (verdict.confianza === 'baja') return true;
  if (technicalRead && fundamentalRead) {
    const t = technicalRead.bias, f = fundamentalRead.bias;
    const opposed = (t === 'bullish' && f === 'bearish') || (t === 'bearish' && f === 'bullish');
    if (opposed) return true;
  }
  return false;
}
```

### Flujo (dos pasadas en `runDecisionMaker`)

```
... técnico + fundamental (SP8/SP9) → reads
evalArgs = { ...args, technical_read, fundamental_read }
first = deps.evaluate(evalArgs)                      ← Sonnet (failover de RESILIENCIA reintenta Sonnet)
if deps.shouldEscalate(first.verdict, techRead, fundRead):
    esc = deps.escalate(evalArgs)                    ← Opus (pasada DELIBERADA)
    final = esc;  escalated = true
else:
    final = first;  escalated = false
persist(final.verdict, model_used = final.modelUsed, escalated, ... reads ...)
```

- **Resiliencia vs escalación separadas:** la pasada Sonnet usa failover de resiliencia que reintenta
  **el mismo modelo** ante error de proveedor (ya NO Opus — eso conflaba resiliencia con escalación).
  La escalación es una **segunda llamada deliberada** a Opus, gobernada por `shouldEscalate`.
- **Best-effort:** si la pasada Opus falla, se degrada al veredicto de Sonnet (`escalated=false` +
  audit `escalation_failed`) — nunca rompe el shadow. El fallo de la pasada Sonnet sigue → `shadow_failed`.
- Modelos por env: `DECISION_MODEL ?? sonnet`; `ESCALATION_MODEL ?? 'anthropic/claude-opus-4-...'`
  (el id exacto de Opus se verifica en `flue dev`, §9; configurable por env, no hardcodeado a un id frágil).

### Persistencia

`shadow_verdicts` gana `escalated boolean` (default false). Va en el mismo INSERT; `model_used` ya
refleja el modelo final (Sonnet u Opus).

## Pieza 2 — Skill `risk-policy`

`src/skills/risk-policy/SKILL.md` — doctrina **cualitativa** de cautela/sizing para el decision-maker
(§151). Registrada en `decisionAgent.skills:[decisionProtocol, riskPolicy]`. `decision-protocol`
instruye: "aplica la doctrina de risk-policy para fijar `sizingFactor` y `confianza`".

Contenido (sin pesos numéricos hardcodeados; los límites duros viven en `check_risk` determinista):
- **Reduce sizing** ante: divergencia precio/momentum, MTF `counter`/`mixed`, `positioning:
  crowded_long` (riesgo de squeeze), baja confluencia, confianza baja, reads contradictorios.
- **Nunca** subir el sizing por encima de la convicción real; el modelo no "apuesta".
- El **risk gate determinista** (`check_risk`, §5/§19) es el techo no negociable: risk-policy es
  *advisory*, no sustituye los límites duros.
- En ausencia de fundamental (ventana tranquila), apoyarse en técnica + esta doctrina.

> No añade cómputo ni capacidad ejecutable: guía el razonamiento (regla del proyecto sobre skills).

## Pieza 3 — Medición A/B (reporte read-only)

### Sustrato (ya existe)

Por `signal_id`:
- `kairos.decisions` (determinista, `model_used='deterministic'`, `verdict` jsonb).
- `kairos.shadow_verdicts` (LLM, `verdict` jsonb + reads + `escalated`).
- `kairos.positions` (`decision_id` → la decisión determinista; `realized_pnl`, `closed_at`) para el
  resultado en `sim`.

### Componentes

1. **`src/db/repositories/shadow-report-query.ts`** — `getShadowVsDeterministic(exec?)` →
   `ABRow[]` con, por señal con ambos veredictos: `signalId`, `detVerdict`, `llmVerdict`,
   `llmEscalated`, `realizedPnl: number | null`, `positionClosed: boolean`. Join read-only
   (`decisions` ⨝ `shadow_verdicts` por `signal_id`, left join `positions` por `decision_id`).
2. **`src/lib/reasoning/shadow-report.ts`** — `computeShadowReport(rows: ABRow[]): ShadowReport`
   **puro**. Métricas:
   - `total`, `bothPresent`.
   - **Acuerdo de acción:** `agreeEnter`, `agreeSkip`, `llmSkipDetEnter`, `llmEnterDetSkip`,
     `agreementRate`.
   - **Sizing/confianza** donde ambos `enter`: distribución de `confianza` LLM; `avgSizingLlm` vs
     `avgSizingDet`.
   - **Escalación:** `escalatedCount`, `escalationRate`.
   - **Edge ponderado por resultado** (solo posiciones cerradas con `realized_pnl`):
     `detPnl` = Σ realized_pnl; `llmPnl` = Σ (si LLM `enter`: `realized_pnl × (llmSizing/detSizing)`;
     si LLM `skip`: 0); `edge = llmPnl − detPnl`. (En `sim` el LLM tomaría el mismo fill; difiere en
     entrar/no y en el sizing.)
3. **`src/cli/shadow-report.ts`** — CLI `npm run shadow-report`: corre la query, computa el reporte,
   lo imprime legible (y opcionalmente JSON). Read-only; no muta nada.

### Honestidad del edge (limitaciones documentadas)

El edge es una **aproximación**: atribuye a cada veredicto LLM el resultado del trade determinista
que sí se ejecutó. No modela divergencias de entry/sl/tp del LLM (en `sim` el fill es el mismo; el LLM
difiere en *entrar/no* y en *cuánto*). Los casos `llmEnterDetSkip` (LLM entra donde el determinista no)
**no tienen P&L observado** (no se abrió posición) → se reportan como conteo, no como P&L. El reporte
lo declara explícitamente para no sobre-vender el número.

## Componentes (resumen)

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/lib/reasoning/escalation.ts` (+test) | `shouldEscalate` puro | Crear |
| `src/db/schema.sql` | columna `escalated boolean` en `shadow_verdicts` | Modificar |
| `src/db/repositories/shadow-verdicts.ts` (+test) | `ShadowVerdictRow.escalated` + INSERT/SELECT | Modificar |
| `src/lib/reasoning/run-decision-maker.ts` (+test) | dos pasadas + deps `shouldEscalate`/`escalate` + persist `escalated` | Modificar |
| `src/skills/risk-policy/SKILL.md` | doctrina de cautela/sizing | Crear |
| `src/skills/decision-protocol/SKILL.md` | instruye aplicar risk-policy | Modificar |
| `src/workflows/decision-maker.ts` | registra `risk-policy`, cablea `shouldEscalate`/`escalate` (Opus) | Modificar |
| `src/db/repositories/shadow-report-query.ts` (+test) | `getShadowVsDeterministic` (join) | Crear |
| `src/lib/reasoning/shadow-report.ts` (+test) | `computeShadowReport` puro | Crear |
| `src/cli/shadow-report.ts` | CLI `npm run shadow-report` | Crear |
| `package.json` | script `shadow-report` | Modificar |
| `.env.example` | `ESCALATION_MODEL` | Modificar |

## Resiliencia y líneas rojas

- **La escalación la decide el código, no el modelo** (línea roja "el LLM juzga, no gatilla"):
  `shouldEscalate` es determinista y puro.
- **La pasada Opus no tiene tools de mutación** (mismo agente decision-maker, `tools:[]`).
- **El reporte A/B es read-only**: solo SELECT; no muta `kairos`. El money path intacto.
- **Best-effort:** fallo de la pasada Opus → degrada a Sonnet + audit `escalation_failed`; nunca
  rompe el shadow. `persist` propaga (infra), como SP7-9.
- **Idempotencia** sin cambios; `escalated` va en el mismo INSERT.
- **Modo**: en SP10 corre en `sim`.

## Estrategia de testing

- **`shouldEscalate` (unit, puro):** tabla — confianza baja → true; analistas opuestos → true;
  alineados/neutral → false; reads null → false.
- **Escalación orquestación (unit):** deps inyectadas — no escala (persist `escalated=false`,
  veredicto Sonnet); escala (persist `escalated=true`, veredicto Opus, model_used Opus); pasada Opus
  falla → degrada a Sonnet + audit `escalation_failed` + `escalated=false`.
- **Persistencia (integración):** round-trip con `escalated` true/false.
- **`computeShadowReport` (unit, puro):** filas inyectadas — acuerdo/divergencia, escalación,
  edge ponderado (LLM enter scaled, LLM skip → 0, posiciones sin cerrar excluidas del P&L).
- **`getShadowVsDeterministic` (integración):** siembra decisions+shadow+positions, verifica el join.
- **Smoke vivo:** `flue run decision-maker` con un candidato normal (no escala, `escalated=false`);
  y un caso de confianza baja / contradicción que **sí** escale a Opus (valida la pasada deliberada).
  Luego `npm run shadow-report` imprime el reporte sobre los datos.
- Cobertura ≥ 80%; `npm run typecheck` en verde.

## Criterios de éxito

- Un candidato dudoso (confianza baja o analistas opuestos) dispara una pasada Opus; el veredicto
  final y `escalated=true` se persisten; `model_used` = Opus. Un candidato normal no escala.
- El fallo de la pasada Opus degrada al veredicto de Sonnet sin romper el shadow (audit `escalation_failed`).
- `risk-policy` está registrada y `decision-protocol` la referencia; el smoke muestra sizing coherente
  con la doctrina (cautela ante hacinamiento/divergencia).
- `npm run shadow-report` produce métricas de acuerdo + edge sobre los datos existentes, read-only.
- La escalación la decide el código (no el modelo); la pasada Opus no tiene tools de mutación.
- `npm test` + `npm run typecheck` en verde; cobertura ≥ 80%.

## Fuera de alcance de SP10

- Triggers de escalación que requieren contexto real (notional > X% equity, primera op live) — testnet/live.
- Que el LLM **ejecute** el camino del dinero (decisión post-A/B, fuera del núcleo sombra).
- Dashboard del A/B (el reporte es CLI; YAGNI).
- Canal de control WhatsApp (SP11).
