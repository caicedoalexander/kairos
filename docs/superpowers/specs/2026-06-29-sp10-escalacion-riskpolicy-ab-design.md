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

- **Skills compuestos (SUPUESTO a validar, H2):** los skills registrados en `skills:[]` están
  *disponibles por disclosure* ("makes the skills available to this agent by their declared names";
  "you can trust the agent to use the skills you provide it, as needed", skills.md:48,93). Lo que la
  doc **NO** garantiza explícitamente es que, durante `session.skill('decision-protocol', { result })`
  (generación restringida a un esquema Valibot, agente con `tools:[]`), el modelo cargue de forma
  autónoma el cuerpo de un segundo skill registrado en el mismo turno. Es plausible (los skills no
  requieren tools) pero no está documentado. → Se trata como **supuesto validado por el smoke**
  (criterio de éxito); **fallback trivial si falla:** incrustar la doctrina de cautela directamente
  en `decision-protocol/SKILL.md` (un solo skill, sin auto-load). Ver Pieza 2.
- `session.skill(name, { args, result, model })` con `model` override por operación → permite la
  pasada Opus deliberada reusando el mismo skill `decision-protocol`.
- Persistencia de dominio en esquema `kairos` (Flue no la maneja).

## Pieza 1 — Escalación determinista Sonnet→Opus

### Regla (`src/lib/reasoning/escalation.ts`)

```ts
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';

// Escalación = decisión DETERMINISTA (el código, no el modelo). En sombra solo aplican las
// condiciones que el camino sombra cablea:
//   - confianza de la pasada Sonnet == 'baja', O
//   - los analistas se contradicen (technical.bias vs fundamental.bias estrictamente opuestos).
// Diferidos a testnet/live (L1): notional > X% equity y primera-op-live de estrategia nueva. NO es
// que sean incomputables en sim (el equity existe en account_snapshots) — es que ShadowEvalArgs no
// cablea equity/estado de cuenta, y "primera op live" no existe en sombra. Se añaden al cablear equity.
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

- **Resiliencia vs escalación separadas (M2):** hoy `decision-maker.ts` arma
  `MODELS = [DECISION_MODEL, DECISION_MODEL_ESCALATION]` que `evaluateWithFailover` consume como
  failover Sonnet→Opus — **exactamente la conflación que SP10 elimina**. El plan debe: (a) cambiar la
  resiliencia a reintentar el **mismo** modelo (`MODELS = [DECISION_MODEL, DECISION_MODEL]`), (b)
  introducir el dep `escalate` separado que llama con `ESCALATION_MODEL`, (c) **retirar**
  `DECISION_MODEL_ESCALATION` y su rama. Así resiliencia (mismo modelo ante blip) y escalación
  (Opus deliberado) quedan desacopladas.
- **Best-effort:** si la pasada Opus falla, se degrada al veredicto de Sonnet (`escalated=false` +
  audit `escalation_failed`) — nunca rompe el shadow. El fallo de la pasada Sonnet sigue → `shadow_failed`.
- **Modelo de escalación (M3):** `ESCALATION_MODEL ?? 'anthropic/claude-opus-4-6'` — un id **concreto**
  por default (el id exacto de Opus se confirma en `flue dev` contra el catálogo de Pi, §292;
  overridable por env). **Nunca** un literal con elipsis (reventaría en runtime y la degradación lo
  enmascararía como best-effort en vez de error de config). El smoke valida que el id resuelve.

### Persistencia

`shadow_verdicts` gana `escalated boolean` (default false). Va en el mismo INSERT; `model_used` ya
refleja el modelo final (Sonnet u Opus).

## Pieza 2 — Skill `risk-policy`

`src/skills/risk-policy/SKILL.md` — doctrina **cualitativa** de cautela/sizing para el decision-maker
(§151). Registrada en `decisionAgent.skills:[decisionProtocol, riskPolicy]`. `decision-protocol`
instruye: "aplica la doctrina de risk-policy para fijar `sizingFactor` y `confianza`".

> **Validación (H2):** el smoke verifica que `risk-policy` realmente mueve `sizingFactor`/`confianza`
> (p. ej. un candidato con divergencia/hacinamiento debe bajar el sizing). **Si el smoke muestra que
> el segundo skill no se aplica** (no auto-carga durante el turno de `decision-protocol`), el fallback
> es **incrustar la doctrina en `decision-protocol/SKILL.md`** y no registrar un skill aparte — cambio
> trivial que elimina la dependencia del auto-load. El plan debe contemplar ambos caminos.

Contenido (sin pesos numéricos hardcodeados; los límites duros viven en `check_risk` determinista):
- **Reduce sizing** ante: divergencia precio/momentum, MTF `counter`/`mixed`, `positioning:
  crowded_long` (riesgo de squeeze), baja confluencia, confianza baja, reads contradictorios.
- **Nunca** subir el sizing por encima de la convicción real; el modelo no "apuesta".
- El **risk gate determinista** (`check_risk`, §5/§19) es el techo no negociable: risk-policy es
  *advisory*, no sustituye los límites duros.
- En ausencia de fundamental (ventana tranquila), apoyarse en técnica + esta doctrina.

> No añade cómputo ni capacidad ejecutable: guía el razonamiento (regla del proyecto sobre skills).

## Pieza 3 — Medición A/B (reporte read-only)

### Sustrato (ya existe) — invariante clave (H1)

Por `signal_id`:
- `kairos.shadow_verdicts` (LLM, `verdict` jsonb + reads + `escalated`) — **se persiste para CADA
  señal evaluada**, tanto si el LLM dice `enter` como `skip` (`runDecisionMaker` no hace early-return).
- `kairos.decisions` (determinista) — **OJO: solo se persiste cuando el veredicto determinista es
  `enter`**. `evaluateCandidate` hace early-return en `skip` y en dedup **antes** de `persistDecision`
  (`orchestration/evaluate-candidate.ts`). Por tanto: **fila en `decisions` ⟺ el determinista quiso
  entrar; ausencia de fila = el determinista NO entró (skip, dedup, o no-evaluado)**.
- `kairos.positions` (`decision_id` → la decisión determinista; `realized_pnl`, `closed_at`,
  `status`) para el resultado en `sim`.

**Anclaje correcto del join (H1):** anclar en `shadow_verdicts` (que tiene enter **y** skip del LLM),
`LEFT JOIN decisions ON signal_id`, `LEFT JOIN positions ON positions.decision_id = decisions.id`.
Derivar `detAction = (fila decisions presente) ? 'enter' : 'skip'`. Anclar en `decisions` (inner join)
sería **ciego a los skip deterministas** → no podría computar `agreeSkip` ni `llmEnterDetSkip` y
sesgaría el `agreementRate`. La convención "ausencia de decisión = no-entró" se documenta en el
reporte (hoy verdadera; frágil si en el futuro se persisten decisiones de skip explícitas).

### Componentes

1. **`src/db/repositories/shadow-report-query.ts`** — `getShadowVsDeterministic(exec?)` →
   `ABRow[]` con, por señal **con veredicto LLM** (ancla en `shadow_verdicts`): `signalId`,
   `llmVerdict`, `llmEscalated`, `detVerdict: Verdict | null` (null = el determinista no entró),
   `realizedPnl: number | null`, `positionClosed: boolean`. Join read-only **anclado en
   `shadow_verdicts`** (`LEFT JOIN decisions ON signal_id`, `LEFT JOIN positions ON decision_id`).
2. **`src/lib/reasoning/shadow-report.ts`** — `computeShadowReport(rows: ABRow[]): ShadowReport`
   **puro**. `detAction = row.detVerdict ? 'enter' : 'skip'`; `llmAction = row.llmVerdict.action`.
   Métricas:
   - `total` (filas con veredicto LLM).
   - **Acuerdo de acción (4 cuadrantes):** `agreeEnter`, `agreeSkip`, `llmSkipDetEnter`,
     `llmEnterDetSkip`, `agreementRate = (agreeEnter+agreeSkip)/total`.
   - **Sizing/confianza** donde ambos `enter`: distribución de `confianza` LLM; `avgSizingLlm` vs
     `avgSizingDet`.
   - **Escalación:** `escalatedCount`, `escalationRate`.
   - **Edge de SIZING ponderado por resultado** (solo `agreeEnter` con posición cerrada y
     `detSizing > 0`): `detPnl` = Σ realized_pnl; `llmPnl` = Σ `realized_pnl × (llmSizing/detSizing)`;
     `sizingEdge = llmPnl − detPnl`. Filas con `detSizing === 0` se excluyen (guarda div/0).
3. **`src/cli/shadow-report.ts`** — CLI `npm run shadow-report`: corre la query, computa el reporte,
   lo imprime legible (y opcionalmente JSON). Read-only; no muta nada.

### Honestidad del edge (limitaciones documentadas, M1)

El `sizingEdge` mide **solo la dimensión de sizing condicionada al desenlace determinista**: cuánto
habría cambiado el P&L si el trade (que sí se ejecutó) se hubiera dimensionado con el `sizingFactor`
del LLM en vez del determinista. **NO** modela:
- La **divergencia de gestión** del LLM: `LlmVerdict` trae su propio `entry`/`sl`/`tp`, distintos de
  los del determinista. Un SL más ajustado del LLM podría stop-out antes y **cambiar el signo** del
  resultado, no solo su magnitud. El `sizingEdge` ignora esto (asume el mismo desenlace).
- Los `llmEnterDetSkip` (LLM entra donde el determinista no): **sin P&L observado** (no se abrió
  posición) → conteo, no P&L.
- Los `agreeEnter` cuyo trade aún no cerró → excluidos del P&L (solo conteo).

El reporte declara estas tres limitaciones en su salida para no sobre-vender el número. El edge es
una **señal direccional de sizing**, no un backtest del LLM (eso requeriría re-simular con sus niveles).

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
| `.env.example` | `ESCALATION_MODEL` (y retirar `DECISION_MODEL_ESCALATION`) | Modificar |
| `ARCHITECTURE.md` §296/§300 | reflejar la separación resiliencia/escalación (M4) | Modificar |

> **Decomposición del plan (L2):** dos grupos de tareas **independientes**. Grupo A
> (escalación + risk-policy): toca `escalation.ts`, `run-decision-maker.ts`, `decision-maker.ts`,
> skills, columna `escalated`. Grupo B (A/B): `shadow-report-query.ts`, `shadow-report.ts`, CLI —
> subsistema read-only sin dependencia dura del Grupo A. El plan los ordena de forma que el fix de H1
> (A/B) no bloquee escalación ni viceversa. Un solo spec/plan; tareas desacopladas.

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

## Hallazgos de revisión de diseño (resueltos en este spec)

Revisado por `kairos-design-reviewer` contra la doc real de Flue (skills.md, models.md),
ARCHITECTURE.md y el código de SP5-9. Veredicto inicial: bloqueado por H1; resoluciones incorporadas:

- **H1 (BLOQUEANTE, resuelto) — el A/B era ciego a los skip deterministas:** `decisions` solo se
  puebla en `enter` (early-return en skip/dedup). El join se re-ancló en `shadow_verdicts LEFT JOIN
  decisions LEFT JOIN positions`, derivando `detAction` por presencia/ausencia de fila → recupera los
  4 cuadrantes. Invariante documentado.
- **H2 — composición de skills es supuesto:** bajado de "verificado" a "supuesto validado por smoke",
  con fallback (incrustar la doctrina en `decision-protocol`) explícito.
- **M1 — edge:** la disclosure ahora aclara que `sizingEdge` mide SOLO la dimensión de sizing
  condicionada al desenlace determinista; NO modela la divergencia SL/TP del LLM (puede cambiar el
  signo). Guarda div/0 (`detSizing === 0` excluido).
- **M2 — env:** el plan migra `DECISION_MODEL_ESCALATION`→`ESCALATION_MODEL`, desmonta el MODELS-array
  de failover (resiliencia = mismo modelo) e introduce el dep `escalate` separado.
- **M3 — default de Opus:** id concreto `'anthropic/claude-opus-4-6'` (no elipsis), confirmable en
  `flue dev`; el smoke valida que resuelve.
- **M4 — ARCHITECTURE:** el plan actualiza §296/§300 para reflejar la separación resiliencia/escalación.
- **L1 — diferimiento:** motivo preciso = ShadowEvalArgs no cablea equity (no es incomputable en sim).
- **L2 — plan:** grupos A (escalación+risk-policy) y B (A/B) desacoplados.

## Fuera de alcance de SP10

- Triggers de escalación que requieren contexto real (notional > X% equity, primera op live) — testnet/live.
- Que el LLM **ejecute** el camino del dinero (decisión post-A/B, fuera del núcleo sombra).
- Dashboard del A/B (el reporte es CLI; YAGNI).
- Canal de control WhatsApp (SP11).
