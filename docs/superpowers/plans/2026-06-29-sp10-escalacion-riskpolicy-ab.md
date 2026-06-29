# SP10 — Escalación Sonnet→Opus + skill `risk-policy` + medición A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar el núcleo de Fase 2: el código escala a Opus cuando el caso es dudoso, el decision-maker aplica la doctrina `risk-policy`, y un reporte A/B read-only mide el edge del LLM (sombra) vs el determinista.

**Architecture:** Dos grupos de tareas desacoplados. Grupo A (escalación+risk-policy): `shouldEscalate` puro + segunda pasada Opus deliberada en `runDecisionMaker` (deps inyectables) + skill `risk-policy` + columna `escalated`. Grupo B (A/B): query read-only que une `shadow_verdicts`⨝`decisions`⨝`positions` + agregación pura + CLI. Todo en sombra sobre `sim`; el money path intacto.

**Tech Stack:** TypeScript (Node target de Flue), Flue 1.0.0-beta.5 (`session.skill` con `model` override, `harness.session`), Valibot, Postgres (esquema `kairos`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-29-sp10-escalacion-riskpolicy-ab-design.md` (hallazgos H1/H2/M1-M4/L1-L2 incorporados).

## Global Constraints

- **Líneas rojas:** la escalación la decide el **código** (`shouldEscalate` puro), no el modelo. La pasada Opus corre sobre el mismo `decisionAgent` con `tools:[]` (sin tools de mutación). El reporte A/B es **read-only** (solo SELECT). El money path (`evaluateCandidate`) no se toca.
- **Verifica la API de Flue contra su doc real** (`node_modules/@flue/runtime/docs/`). Hechos: `session.skill(name, { args, result, model })` con `model` override por operación; `harness.session(name?)` get/create; skills registrados disponibles por disclosure.
- **Resiliencia vs escalación separadas (M2):** la pasada Sonnet reintenta el **mismo** modelo ante blip (`MODELS=[DECISION_MODEL, DECISION_MODEL]`); la escalación es una segunda llamada deliberada a Opus. Retirar `DECISION_MODEL_ESCALATION`.
- **`ESCALATION_MODEL ?? 'anthropic/claude-opus-4-6'`** (M3): id concreto, confirmable en `flue dev`; nunca un literal con elipsis.
- **Best-effort:** fallo de la pasada Opus → degrada al veredicto de Sonnet + audit `escalation_failed`; nunca rompe el shadow. `persist` propaga (infra), como SP7-9.
- **Invariante del A/B (H1):** fila en `decisions` ⟺ el determinista quiso `enter` (`evaluateCandidate` hace early-return en skip/dedup antes de `persistDecision`). El join se ancla en `shadow_verdicts` y deriva `detAction` por presencia/ausencia de fila en `decisions`.
- **Idempotencia sin cambios:** `escalated` va en el mismo INSERT.
- **Flue descubre TODO `.ts` plano** en `src/workflows|channels|agents/` → no `.test.ts` ni no-workflows ahí.
- **Estilo:** funciones <50 líneas, archivos <800, inmutabilidad, validación en límites, sin secretos, sin `console.log` de debug (el CLI usa `process.stdout.write`/`console.log` legítimo de salida). Español en docs/comentarios.
- **Cobertura ≥ 80%**; `npm run typecheck` en verde (salvo estados intermedios documentados).

## File Structure

| Archivo | Responsabilidad | Acción | Grupo |
|---|---|---|---|
| `src/lib/reasoning/escalation.ts` (+test) | `shouldEscalate` puro | Crear | A |
| `src/db/schema.sql` | columna `escalated boolean` en `shadow_verdicts` | Modificar | A |
| `src/db/repositories/shadow-verdicts.ts` (+test) | `ShadowVerdictRow.escalated` + INSERT/SELECT | Modificar | A |
| `src/lib/reasoning/run-decision-maker.ts` (+test) | dos pasadas + deps `shouldEscalate`/`escalate` + persist `escalated` | Modificar | A |
| `src/skills/risk-policy/SKILL.md` | doctrina de cautela/sizing | Crear | A |
| `src/skills/decision-protocol/SKILL.md` | instruye aplicar risk-policy | Modificar | A |
| `src/workflows/decision-maker.ts` | registra risk-policy, cablea escalación (Opus), migra env | Modificar | A |
| `.env.example`, `ARCHITECTURE.md` | `ESCALATION_MODEL`; §296/§300 | Modificar | A |
| `src/db/repositories/shadow-report-query.ts` (+test) | `getShadowVsDeterministic` (join) | Crear | B |
| `src/lib/reasoning/shadow-report.ts` (+test) | `computeShadowReport` puro | Crear | B |
| `src/cli/shadow-report.ts`, `package.json` | CLI `npm run shadow-report` | Crear/Modificar | B |

---

### Task 1: `shouldEscalate` (regla determinista de escalación)

**Files:**
- Create: `src/lib/reasoning/escalation.ts`
- Test: `src/lib/reasoning/escalation.test.ts`

**Interfaces:**
- Consumes: `LlmVerdict` (`./verdict-schema.ts`), `TechnicalRead` (`./technical-read-schema.ts`), `FundamentalRead` (`./fundamental-read-schema.ts`).
- Produces: `shouldEscalate(verdict: LlmVerdict, technicalRead: TechnicalRead | null, fundamentalRead: FundamentalRead | null): boolean`. Tarea 4 (orquestación) consume esta firma.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reasoning/escalation.test.ts
import { describe, test, expect } from 'vitest';
import { shouldEscalate } from './escalation.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';

const V = (confianza: 'alta' | 'media' | 'baja'): LlmVerdict => ({ action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.5, confianza, razonamiento: 'x' });
const tech = (bias: 'bullish' | 'neutral' | 'bearish'): TechnicalRead => ({ bias, confluence: 'moderate', regime: 'trending', divergence: 'none', mtfNote: 'm', notes: 'n' });
const fund = (bias: 'bullish' | 'neutral' | 'bearish'): FundamentalRead => ({ bias, catalysts: [], positioning: 'neutral', confidence: 'media' });

describe('shouldEscalate', () => {
  test('confianza baja → escala', () => {
    expect(shouldEscalate(V('baja'), tech('bullish'), fund('bullish'))).toBe(true);
  });
  test('analistas opuestos (técnico bullish, fundamental bearish) → escala', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), fund('bearish'))).toBe(true);
  });
  test('analistas opuestos al revés (técnico bearish, fundamental bullish) → escala', () => {
    expect(shouldEscalate(V('media'), tech('bearish'), fund('bullish'))).toBe(true);
  });
  test('confianza alta y analistas alineados → no escala', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), fund('bullish'))).toBe(false);
  });
  test('un read neutral no cuenta como contradicción', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), fund('neutral'))).toBe(false);
  });
  test('sin fundamental (null) y confianza alta → no escala', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reasoning/escalation.test.ts`
Expected: FAIL — `Cannot find module './escalation.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/reasoning/escalation.ts
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';

// Escalación = decisión DETERMINISTA (el código, no el modelo), §296. En sombra solo las condiciones
// que el camino sombra cablea: confianza baja de Sonnet O analistas estrictamente opuestos.
// Diferidos (testnet/live): notional > X% equity, primera-op-live (ShadowEvalArgs no cablea equity).
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reasoning/escalation.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/escalation.ts src/lib/reasoning/escalation.test.ts
git commit -m "feat: shouldEscalate (regla determinista Sonnet→Opus, SP10)"
```

---

### Task 2: Columna `escalated` en `shadow_verdicts`

**Files:**
- Modify: `src/db/schema.sql` (tabla `shadow_verdicts`)
- Modify: `src/db/repositories/shadow-verdicts.ts`
- Test: `src/db/repositories/shadow-verdicts.test.ts` (integración)

**Interfaces:**
- Produces: `ShadowVerdictRow.escalated: boolean`. `insertShadowVerdict`/`getShadowVerdict` manejan el campo. Tarea 4 construye el row con `escalated`.

> `migrate.test.ts` valida nombres de tabla (no columnas) → no se toca.

- [ ] **Step 1: Write the failing test (extiende el round-trip)**

En `src/db/repositories/shadow-verdicts.test.ts`, en el test `'insert + get round-trip; isAlreadyEvaluated'` añade `escalated: true` a la llamada `insertShadowVerdict` y una aserción `expect(row?.escalated).toBe(true);`. En el test `'fundamental omitido'` añade `escalated: false` a la llamada y `expect(row?.escalated).toBe(false);`. Y añade `escalated: false` a ambas llamadas del test `'ON CONFLICT DO NOTHING'` (para que compilen tras extender `ShadowVerdictRow`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/shadow-verdicts.test.ts`
Expected: FAIL — `escalated` no existe en `ShadowVerdictRow` / columna inexistente.

- [ ] **Step 3: Modify `schema.sql`**

En la definición de `shadow_verdicts`, añade la columna `escalated boolean NOT NULL DEFAULT false` (tras `fundamental_fetch_ok`, antes de `created_at`), y un ALTER idempotente al final del bloque de ALTERs de SP9:

```sql
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS escalated boolean NOT NULL DEFAULT false;
```

- [ ] **Step 4: Modify the repo**

En `src/db/repositories/shadow-verdicts.ts`:
- `ShadowVerdictRow` gana `escalated: boolean;`.
- El INSERT añade `escalated` como columna `$16` y al array de valores `row.escalated`.
- `ShadowRow` (interfaz interna del SELECT) gana `escalated: boolean;`, el SELECT añade `escalated`, y el mapeo de retorno añade `escalated: r.escalated`.

```ts
// ShadowVerdictRow: añadir
  escalated: boolean;

// INSERT: columnas (añadir al final de la lista, antes del cierre) e índice $16
//   ... fundamental_status, fundamental_fetch_ok, escalated)
//   VALUES ($1 ... $15, $16)
//   ... row.fundamentalStatus, row.fundamentalFetchOk, row.escalated],

// ShadowRow: añadir `escalated: boolean;`
// SELECT: añadir `, escalated`
// retorno: añadir `escalated: r.escalated,`
```

- [ ] **Step 5: Run migrate + test**

Run: `npm run migrate && npx vitest run src/db/repositories/shadow-verdicts.test.ts`
Expected: migrate aplica el ALTER; tests PASS.

> **Estado intermedio (L1):** `escalated` requerido en `ShadowVerdictRow` → `run-decision-maker.ts` (SP9) no lo provee → `npm run typecheck` ROJO hasta Task 4. Vitest sigue verde. No uses typecheck como gate entre Task 2 y Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/repositories/shadow-verdicts.ts src/db/repositories/shadow-verdicts.test.ts
git commit -m "feat: shadow_verdicts persiste escalated (SP10)"
```

---

### Task 3: Escalación en `runDecisionMaker` (segunda pasada Opus deliberada)

**Files:**
- Modify: `src/lib/reasoning/run-decision-maker.ts`
- Modify: `src/workflows/decision-maker.ts` (stubs temporales)
- Test: `src/lib/reasoning/run-decision-maker.test.ts`

**Interfaces:**
- Consumes: `shouldEscalate` firma (Task 1); `ShadowVerdictRow.escalated` (Task 2).
- Produces: `DecisionMakerDeps` gana `shouldEscalate: (verdict: LlmVerdict, technicalRead: TechnicalRead | null, fundamentalRead: FundamentalRead | null) => boolean` y `escalate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>`. Persist incluye `escalated`. Tarea 4 cablea estas deps.

- [ ] **Step 1: Write the failing tests**

En `src/lib/reasoning/run-decision-maker.test.ts`, extiende el helper `deps()` con los 2 defaults nuevos (camino "no escala" por defecto), antes del `...over`:

```ts
    shouldEscalate: () => false,
    escalate: async () => ({ verdict: { ...VERDICT, confianza: 'alta' }, modelUsed: 'anthropic/claude-opus-4-6', tokens: 999 }),
```

Tests nuevos:

```ts
  test('no escala → persiste escalated=false y el veredicto de la primera pasada', async () => {
    const d = deps();
    await runDecisionMaker('sig1', d);
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ escalated: false, modelUsed: 'anthropic/claude-sonnet-4-6' }));
  });

  test('escala → corre Opus, persiste escalated=true y el veredicto/model de Opus', async () => {
    const opusVerdict = { ...VERDICT, confianza: 'alta' as const };
    const d = deps({ shouldEscalate: () => true, escalate: async () => ({ verdict: opusVerdict, modelUsed: 'anthropic/claude-opus-4-6', tokens: 999 }) });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ escalated: true, modelUsed: 'anthropic/claude-opus-4-6', tokens: 999 }));
  });

  test('pasada Opus falla → degrada a Sonnet (escalated=false) + audit escalation_failed', async () => {
    const d = deps({ shouldEscalate: () => true, escalate: async () => { throw new Error('opus caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'escalation_failed' }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ escalated: false, modelUsed: 'anthropic/claude-sonnet-4-6' }));
  });
```

> Los tests existentes que afirman `persist` con `objectContaining` siguen verdes (el helper provee `shouldEscalate:()=>false` por defecto → `escalated:false`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts`
Expected: FAIL — `shouldEscalate`/`escalate` no existen en `DecisionMakerDeps`; persist no recibe `escalated`.

- [ ] **Step 3: Modify `run-decision-maker.ts`**

Añade los imports de tipos si faltan (`TechnicalRead`, `FundamentalRead` ya están). En `DecisionMakerDeps`, añade tras `evaluate`:

```ts
  shouldEscalate: (verdict: LlmVerdict, technicalRead: TechnicalRead | null, fundamentalRead: FundamentalRead | null) => boolean;
  escalate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
```

Reemplaza el bloque desde `let evaluated...` hasta el `return { kind: 'persisted' ... }` final por:

```ts
  let first: { verdict: LlmVerdict; modelUsed: string; tokens: number | null };
  try {
    first = await deps.evaluate(evalArgs);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await deps.audit({
        eventType: 'shadow_failed', actor: 'decision-maker',
        payload: { signalId, error, technicalRead: tech.read, technicalModel: tech.model, technicalTokens: tech.tokens,
          fundamentalRead: fund.read, fundamentalModel: fund.model, fundamentalTokens: fund.tokens, fundamentalStatus: fund.status },
      });
    } catch { /* best-effort */ }
    return { kind: 'failed', error };
  }

  // Escalación DELIBERADA (SP10): el código decide, no el modelo. Best-effort: Opus falla → Sonnet + audit.
  let finalVerdict = first.verdict, finalModel = first.modelUsed, finalTokens = first.tokens;
  let escalated = false;
  if (deps.shouldEscalate(first.verdict, tech.read, fund.read)) {
    try {
      const esc = await deps.escalate(evalArgs);
      finalVerdict = esc.verdict; finalModel = esc.modelUsed; finalTokens = esc.tokens; escalated = true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      const errorType = err instanceof Error ? err.name : 'unknown';
      try {
        await deps.audit({ eventType: 'escalation_failed', actor: 'decision-maker', payload: { signalId, error, errorType } });
      } catch { /* best-effort */ }
    }
  }

  await deps.persist({
    signalId, verdict: finalVerdict, confianza: finalVerdict.confianza,
    razonamiento: finalVerdict.razonamiento, modelUsed: finalModel, tokens: finalTokens,
    technicalRead: tech.read, technicalModel: tech.model, technicalTokens: tech.tokens,
    fundamentalRead: fund.read, fundamentalModel: fund.model, fundamentalTokens: fund.tokens,
    fundamentalStatus: fund.status, fundamentalFetchOk: fund.fetchOk,
    escalated,
  });
  return { kind: 'persisted', verdict: finalVerdict };
```

- [ ] **Step 4: Add temporary stubs in `decision-maker.ts`**

`DecisionMakerDeps` exige 2 deps nuevas. Para typecheck verde hasta Task 4, añade en el objeto `deps` de `decision-maker.ts` (tras `evaluate:`):

```ts
      // SP10-Task4 reemplaza estos stubs con shouldEscalate real + escalate (Opus):
      shouldEscalate: () => false,
      escalate: async () => { throw new Error('SP10-Task4 pendiente: cableado de escalate'); },
```

(Con `shouldEscalate:()=>false`, `escalate` nunca se invoca en runtime entre Task 3 y Task 4.)

- [ ] **Step 5: Tests + typecheck**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts && npm run typecheck`
Expected: tests PASS (existentes + 3 nuevos); typecheck **verde** (cierra el estado intermedio de Task 2).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reasoning/run-decision-maker.ts src/lib/reasoning/run-decision-maker.test.ts src/workflows/decision-maker.ts
git commit -m "feat: runDecisionMaker escala a Opus con degradación (SP10)"
```

---

### Task 4: Skill `risk-policy` + cableado real (escalación + env migration)

**Files:**
- Create: `src/skills/risk-policy/SKILL.md`
- Modify: `src/skills/decision-protocol/SKILL.md`
- Modify: `src/workflows/decision-maker.ts`
- Modify: `.env.example`, `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `shouldEscalate` (Task 1); `evaluateWithFailover`/`SkillSession` (SP7); `runDecisionMaker`/`DecisionMakerDeps` (Task 3).
- Produces: workflow `decision-maker` con escalación + risk-policy cableados. Validado por typecheck + suite + smoke. La pasada Opus corre sobre `harness.session('escalation')` (sesión dedicada, juicio Opus independiente del transcript de Sonnet).

> Flue-discovery: `decision-maker.ts` es workflow descubierto. El skill nuevo va en `src/skills/risk-policy/`.

- [ ] **Step 1: Crear `src/skills/risk-policy/SKILL.md`**

```markdown
---
name: risk-policy
description: Doctrina cualitativa de cautela y sizing para el decision-maker de Kairos. Cómo traducir la evidencia (reads técnico/fundamental) en sizingFactor y confianza prudentes. Los límites duros viven en el risk gate determinista, no aquí.
---

# Política de riesgo (Kairos)

Doctrina **cualitativa** para fijar `sizingFactor` y `confianza` al emitir el veredicto. **No** define
límites numéricos duros: esos los aplica `check_risk` (determinista, §5/§19) y son el techo no
negociable. Esta doctrina es *advisory* — te ayuda a no sobre-dimensionar.

## Reduce el sizing (y/o baja la confianza) ante

- **Divergencia** precio/momentum (el `technical_read.divergence` no es `none`).
- **MTF no alineado**: `mtfNote` que describe `counter`/`mixed` — el gatillo contra el sesgo HTF pide cautela.
- **Posicionamiento hacinado**: `fundamental_read.positioning: crowded_long` → riesgo de squeeze en una entrada larga.
- **Baja confluencia** (`technical_read.confluence: weak`) o **régimen de rango** (`regime: ranging`) en una ruptura.
- **Catalizador fundamental adverso** o reads **contradictorios** (técnico y fundamental con sesgo opuesto).
- **Confianza propia baja**: si no estás convencido, el `sizingFactor` debe reflejarlo.

## Principios

- **Nunca** subas el `sizingFactor` por encima de tu convicción real. No "apuestas" para recuperar.
- En **ausencia de fundamental** (ventana tranquila), apóyate en la técnica + esta doctrina.
- El `sizingFactor` ∈ [0,1] es un **factor de convicción**, no el tamaño final: el risk gate lo capará
  contra los límites de la estrategia (notional, exposición, drawdown). Aun así, sé honesto: un gate
  que capa un factor inflado no te exime de calibrarlo bien.
- Confluencia fuerte + MTF alineado + sin catalizador adverso + posicionamiento sano → `confianza` alta
  y `sizingFactor` acorde. La cautela no es timidez: es proporcionalidad a la evidencia.
```

- [ ] **Step 2: Editar `src/skills/decision-protocol/SKILL.md`**

En la sección de salida (donde define `sizingFactor`), añade una línea que instruya aplicar la doctrina:

```markdown
- Para fijar `sizingFactor` y `confianza`, **aplica la doctrina del skill `risk-policy`**: reduce el
  tamaño ante divergencia, MTF no alineado, posicionamiento hacinado (`crowded_long`), baja confluencia
  o reads contradictorios; nunca por encima de tu convicción real. Los límites duros los capa el risk
  gate determinista — tu trabajo es calibrar con prudencia.
```

- [ ] **Step 3: Editar `src/workflows/decision-maker.ts`**

Reemplaza el archivo por (cambios vs SP9: import `riskPolicy` + `shouldEscalate`; `ESCALATION_MODEL`; retira `DECISION_MODEL_ESCALATION` y arma `MODELS=[DECISION_MODEL, DECISION_MODEL]`; registra `riskPolicy` en skills; cablea `shouldEscalate` + `escalate` sobre sesión `escalation`):

```ts
import { defineAgent, defineAgentProfile, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import decisionProtocol from '../skills/decision-protocol/SKILL.md' with { type: 'skill' };
import riskPolicy from '../skills/risk-policy/SKILL.md' with { type: 'skill' };
import technicalRead from '../skills/technical-read/SKILL.md' with { type: 'skill' };
import fundamentalRead from '../skills/fundamental-read/SKILL.md' with { type: 'skill' };
import { evaluateWithFailover, type SkillSession } from '../lib/reasoning/evaluate-with-failover.ts';
import { analyzeTechnical, type TaskSession } from '../lib/reasoning/analyze-technical.ts';
import { analyzeFundamental, type FundamentalTaskSession } from '../lib/reasoning/analyze-fundamental.ts';
import { isMajorCap, shouldRunFundamental } from '../lib/reasoning/fundamental-gate.ts';
import { shouldEscalate } from '../lib/reasoning/escalation.ts';
import { fetchCryptoPanicNews } from '../lib/sources/cryptopanic.ts';
import { runDecisionMaker, type DecisionMakerDeps } from '../lib/reasoning/run-decision-maker.ts';
import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { insertShadowVerdict, isAlreadyEvaluated } from '../db/repositories/shadow-verdicts.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Modelos por env (§9). Resiliencia = reintenta el MISMO modelo ante blip (NO Opus — eso conflaba
// resiliencia con escalación, M2). La escalación es una pasada deliberada a Opus (shouldEscalate).
const DECISION_MODEL = process.env.DECISION_MODEL ?? 'anthropic/claude-sonnet-4-6';
const MODELS = [DECISION_MODEL, DECISION_MODEL];
const ESCALATION_MODEL = process.env.ESCALATION_MODEL ?? 'anthropic/claude-opus-4-6';
const TECHNICAL_MODEL = process.env.TECHNICAL_MODEL ?? 'anthropic/claude-haiku-4-5';
const FUNDAMENTAL_MODEL = process.env.FUNDAMENTAL_MODEL ?? 'anthropic/claude-haiku-4-5';

const technicalAnalyst = defineAgentProfile({
  name: 'technical-analyst',
  description: 'Interpreta el snapshot de indicadores ya computado y emite un technical_read cualitativo. Solo lectura.',
  model: TECHNICAL_MODEL,
  thinkingLevel: 'medium',
  skills: [technicalRead],
  tools: [],
});

const fundamentalAnalyst = defineAgentProfile({
  name: 'fundamental-analyst',
  description: 'Lee catalizadores (noticias) y posicionamiento (funding/OI) de un major-cap y emite un fundamental_read. Solo lectura.',
  model: FUNDAMENTAL_MODEL,
  thinkingLevel: 'medium',
  skills: [fundamentalRead],
  tools: [],
});

const decisionAgent = defineAgent(() => ({
  model: DECISION_MODEL,
  thinkingLevel: 'high',
  skills: [decisionProtocol, riskPolicy],
  subagents: [technicalAnalyst, fundamentalAnalyst],
  tools: [],  // SIN tools de mutación (línea roja): el decision-maker solo emite veredicto.
}));

export default defineWorkflow({
  agent: decisionAgent,
  input: v.object({ signalId: v.string() }),
  output: v.object({ outcome: v.picklist(['persisted', 'not_found', 'duplicate', 'failed']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    const techSession = (await harness.session('technical')) as unknown as TaskSession;
    const fundSession = (await harness.session('fundamental')) as unknown as FundamentalTaskSession;
    // Sesión dedicada para la pasada Opus: juicio independiente del transcript de Sonnet.
    const escSession = (await harness.session('escalation')) as unknown as SkillSession;
    const deps: DecisionMakerDeps = {
      getSignal: getSignalById,
      getStrategy,
      isAlreadyEvaluated,
      analyze: (args) => analyzeTechnical(techSession, args as unknown as Record<string, unknown>, TECHNICAL_MODEL),
      isMajorCap,
      fetchNews: (symbol) => fetchCryptoPanicNews(symbol),
      shouldRunFundamental,
      analyzeFundamental: (fargs) => analyzeFundamental(fundSession, fargs as unknown as Record<string, unknown>, FUNDAMENTAL_MODEL),
      evaluate: (args) => evaluateWithFailover(session, args as unknown as Record<string, unknown>, MODELS),
      shouldEscalate,
      escalate: (args) => evaluateWithFailover(escSession, args as unknown as Record<string, unknown>, [ESCALATION_MODEL, ESCALATION_MODEL]),
      persist: insertShadowVerdict,
      audit: appendAuditLog,
    };
    const result = await runDecisionMaker(input.signalId, deps);
    return { outcome: result.kind };
  },
});
```

- [ ] **Step 4: Migrar env y ARCHITECTURE**

- `.env.example`: reemplaza la línea `DECISION_MODEL_ESCALATION=...` (si existe) por `ESCALATION_MODEL=` con comentario `# default anthropic/claude-opus-4-6 (confirmar id en flue dev)`.
- `ARCHITECTURE.md` §300: tras "La orquestación envuelve la llamada y reintenta en un modelo alterno ante error de proveedor", añade una nota: "**(SP10)** La resiliencia reintenta el **mismo** modelo; la escalación a Opus es una **segunda pasada deliberada** gobernada por `shouldEscalate` (no un fallback de resiliencia)." En §296, añade que en sombra solo aplican confianza-baja y contradicción-de-analistas (notional/primera-op-live se cablean con equity en testnet/live).

- [ ] **Step 5: Typecheck + suite completa**

Run: `npm run typecheck && npm test`
Expected: typecheck limpio; toda la suite verde. Cobertura ≥ 80%.

> **Verifica antes de commitear:** `decisionAgent` y ambos profiles llevan `tools: []`; no se quedó ninguna referencia a `DECISION_MODEL_ESCALATION`.

- [ ] **Step 6: Commit**

```bash
git add src/skills/risk-policy/SKILL.md src/skills/decision-protocol/SKILL.md src/workflows/decision-maker.ts .env.example ARCHITECTURE.md
git commit -m "feat: cablea escalación Opus + risk-policy en decision-maker (SP10)"
```

---

### Task 5: Query A/B `getShadowVsDeterministic` (join read-only)

**Files:**
- Create: `src/db/repositories/shadow-report-query.ts`
- Test: `src/db/repositories/shadow-report-query.test.ts` (integración)

**Interfaces:**
- Consumes: `Verdict` (`../../lib/execution/types.ts`), `LlmVerdict` (`../../lib/reasoning/verdict-schema.ts`).
- Produces: `interface ABRow { signalId: string; llmVerdict: LlmVerdict; llmEscalated: boolean; detVerdict: Verdict | null; realizedPnl: number | null; positionClosed: boolean }`; `getShadowVsDeterministic(exec?: Executor): Promise<ABRow[]>`. Tarea 6 consume `ABRow`.

> **Anclaje (H1):** ancla en `shadow_verdicts`, `LEFT JOIN decisions` por `signal_id`, `LEFT JOIN positions` por `decision_id`. `detVerdict=null` ⟺ el determinista no entró (fila de decisión ausente).

- [ ] **Step 1: Write the failing test**

```ts
// src/db/repositories/shadow-report-query.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { insertShadowVerdict } from './shadow-verdicts.ts';
import { persistDecision } from './decisions.ts';
import { getShadowVsDeterministic } from './shadow-report-query.ts';
import type { Signal } from '../../lib/scanner/types.ts';
import type { Verdict } from '../../lib/execution/types.ts';

const SYMBOL = 'ABREPORTBTC/USDT';
const STRATEGY_ID = 'abreport-strategy';
const DET: Verdict = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.6 };
const LLM = { action: 'enter' as const, entry: 100, sl: 97, tp: 106, sizingFactor: 0.4, confianza: 'media' as const, razonamiento: 'x' };

async function seedSignal(): Promise<string> {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`, [STRATEGY_ID, `{${SYMBOL}}`]);
  const s: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-06-29T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  return insertSignal(s);
}
function fullShadowRow(signalId: string) {
  return { signalId, verdict: LLM, confianza: 'media', razonamiento: 'x', modelUsed: 'm', tokens: 1,
    technicalRead: null, technicalModel: null, technicalTokens: null,
    fundamentalRead: null, fundamentalModel: null, fundamentalTokens: null, fundamentalStatus: null, fundamentalFetchOk: null, escalated: false };
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.shadow_verdicts WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('getShadowVsDeterministic', () => {
  test('det enter (con decisión) + posición cerrada → detVerdict y realizedPnl presentes', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict(fullShadowRow(signalId));
    const dec = await persistDecision(signalId, DET);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, realized_pnl, strategy_id, mode, decision_id, closed_at)
                 VALUES ('pos-abreport', $1, 'long', 100, 1, 97, 106, 'closed', 12.5, $2, 'sim', $3, now())`, [SYMBOL, STRATEGY_ID, dec.id]);
    const rows = (await getShadowVsDeterministic()).filter((r) => r.signalId === signalId);
    expect(rows).toHaveLength(1);
    expect(rows[0].detVerdict?.action).toBe('enter');
    expect(rows[0].llmVerdict.sizingFactor).toBe(0.4);
    expect(rows[0].positionClosed).toBe(true);
    expect(rows[0].realizedPnl).toBe(12.5);
  });

  test('det skip (sin decisión) → detVerdict null, sin posición', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict(fullShadowRow(signalId));
    const rows = (await getShadowVsDeterministic()).filter((r) => r.signalId === signalId);
    expect(rows).toHaveLength(1);
    expect(rows[0].detVerdict).toBeNull();
    expect(rows[0].positionClosed).toBe(false);
    expect(rows[0].realizedPnl).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/shadow-report-query.test.ts`
Expected: FAIL — `Cannot find module './shadow-report-query.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/db/repositories/shadow-report-query.ts
import { query, type Executor } from '../pool.ts';
import type { Verdict } from '../../lib/execution/types.ts';
import type { LlmVerdict } from '../../lib/reasoning/verdict-schema.ts';

export interface ABRow {
  signalId: string;
  llmVerdict: LlmVerdict;
  llmEscalated: boolean;
  detVerdict: Verdict | null;   // null ⟺ el determinista NO entró (sin fila en decisions)
  realizedPnl: number | null;   // null si no hay posición cerrada
  positionClosed: boolean;
}

interface RawRow {
  signal_id: string; llm_verdict: LlmVerdict; escalated: boolean;
  det_verdict: Verdict | null; realized_pnl: string | number | null; pos_status: string | null;
}

// Read-only. Ancla en shadow_verdicts (tiene enter Y skip del LLM); LEFT JOIN decisions (presente
// solo en det-enter, H1) y positions (resultado en sim). detVerdict null = el determinista no entró.
export async function getShadowVsDeterministic(exec: Executor = query): Promise<ABRow[]> {
  const rows = await exec<RawRow>(
    `SELECT sv.signal_id, sv.verdict AS llm_verdict, sv.escalated,
            d.verdict AS det_verdict, p.realized_pnl, p.status AS pos_status
       FROM kairos.shadow_verdicts sv
       LEFT JOIN kairos.decisions d ON d.signal_id = sv.signal_id
       LEFT JOIN kairos.positions p ON p.decision_id = d.id`,
  );
  return rows.map((r) => {
    const closed = r.pos_status === 'closed';
    return {
      signalId: r.signal_id, llmVerdict: r.llm_verdict, llmEscalated: r.escalated,
      detVerdict: r.det_verdict, positionClosed: closed,
      realizedPnl: closed && r.realized_pnl !== null ? Number(r.realized_pnl) : null,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/shadow-report-query.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/shadow-report-query.ts src/db/repositories/shadow-report-query.test.ts
git commit -m "feat: query A/B shadow vs determinista (anclada en shadow_verdicts, SP10)"
```

---

### Task 6: Agregación A/B `computeShadowReport` (pura)

**Files:**
- Create: `src/lib/reasoning/shadow-report.ts`
- Test: `src/lib/reasoning/shadow-report.test.ts`

**Interfaces:**
- Consumes: `ABRow` (`../../db/repositories/shadow-report-query.ts`).
- Produces: `interface ShadowReport { ... }` (campos abajo) y `computeShadowReport(rows: ABRow[]): ShadowReport`. Tarea 7 consume ambos.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reasoning/shadow-report.test.ts
import { describe, test, expect } from 'vitest';
import { computeShadowReport } from './shadow-report.ts';
import type { ABRow } from '../../db/repositories/shadow-report-query.ts';

const llm = (action: 'enter' | 'skip', sizingFactor: number, confianza: 'alta' | 'media' | 'baja' = 'media') =>
  ({ action, entry: 100, sl: 97, tp: 106, sizingFactor, confianza, razonamiento: 'x' });
const det = (sizingFactor: number) => ({ action: 'enter' as const, entry: 100, sl: 97, tp: 106, sizingFactor });

function row(over: Partial<ABRow>): ABRow {
  return { signalId: 's', llmVerdict: llm('enter', 0.5), llmEscalated: false, detVerdict: det(0.5), realizedPnl: null, positionClosed: false, ...over };
}

describe('computeShadowReport', () => {
  test('cuadrantes de acuerdo de acción', () => {
    const rows: ABRow[] = [
      row({ llmVerdict: llm('enter', 0.5), detVerdict: det(0.5) }),   // agreeEnter
      row({ llmVerdict: llm('skip', 0), detVerdict: null }),          // agreeSkip
      row({ llmVerdict: llm('skip', 0), detVerdict: det(0.5) }),      // llmSkipDetEnter
      row({ llmVerdict: llm('enter', 0.5), detVerdict: null }),       // llmEnterDetSkip
    ];
    const r = computeShadowReport(rows);
    expect(r.total).toBe(4);
    expect(r.agreeEnter).toBe(1);
    expect(r.agreeSkip).toBe(1);
    expect(r.llmSkipDetEnter).toBe(1);
    expect(r.llmEnterDetSkip).toBe(1);
    expect(r.agreementRate).toBeCloseTo(0.5);
  });

  test('escalación contada', () => {
    const r = computeShadowReport([row({ llmEscalated: true }), row({ llmEscalated: false })]);
    expect(r.escalatedCount).toBe(1);
    expect(r.escalationRate).toBeCloseTo(0.5);
  });

  test('sizingEdge: solo agreeEnter cerrados con detSizing>0; LLM escala el P&L por su sizing', () => {
    const rows: ABRow[] = [
      // agreeEnter cerrado: det sizing 0.5, llm sizing 0.25 → llmPnl = 10 * (0.25/0.5) = 5
      row({ llmVerdict: llm('enter', 0.25), detVerdict: det(0.5), positionClosed: true, realizedPnl: 10 }),
      // agreeEnter sin cerrar → excluido del P&L
      row({ llmVerdict: llm('enter', 0.5), detVerdict: det(0.5), positionClosed: false, realizedPnl: null }),
    ];
    const r = computeShadowReport(rows);
    expect(r.sizingEdge?.detPnl).toBeCloseTo(10);
    expect(r.sizingEdge?.llmPnl).toBeCloseTo(5);
    expect(r.sizingEdge?.edge).toBeCloseTo(-5);
    expect(r.sizingEdge?.closedCount).toBe(1);
  });

  test('detSizing=0 se excluye del edge (guarda div/0)', () => {
    const r = computeShadowReport([row({ llmVerdict: llm('enter', 0.5), detVerdict: det(0), positionClosed: true, realizedPnl: 10 })]);
    expect(r.sizingEdge?.closedCount).toBe(0);
  });

  test('sin filas → total 0, sizingEdge null', () => {
    const r = computeShadowReport([]);
    expect(r.total).toBe(0);
    expect(r.sizingEdge).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reasoning/shadow-report.test.ts`
Expected: FAIL — `Cannot find module './shadow-report.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/reasoning/shadow-report.ts
import type { ABRow } from '../../db/repositories/shadow-report-query.ts';

export interface ShadowReport {
  total: number;
  agreeEnter: number; agreeSkip: number; llmSkipDetEnter: number; llmEnterDetSkip: number;
  agreementRate: number;
  confianzaDist: Record<string, number>;   // sobre veredictos LLM 'enter'
  avgSizingLlm: number | null; avgSizingDet: number | null;   // sobre agreeEnter
  escalatedCount: number; escalationRate: number;
  // Edge de SIZING (M1): SOLO mide la dimensión de sizing condicionada al desenlace determinista.
  // NO modela la divergencia SL/TP del LLM (puede cambiar el signo). llmEnterDetSkip sin P&L observado.
  sizingEdge: { detPnl: number; llmPnl: number; edge: number; closedCount: number } | null;
}

export function computeShadowReport(rows: ABRow[]): ShadowReport {
  const total = rows.length;
  let agreeEnter = 0, agreeSkip = 0, llmSkipDetEnter = 0, llmEnterDetSkip = 0, escalatedCount = 0;
  const confianzaDist: Record<string, number> = {};
  let sumLlm = 0, sumDet = 0, agreeEnterN = 0;
  let detPnl = 0, llmPnl = 0, closedCount = 0;

  for (const r of rows) {
    if (r.llmEscalated) escalatedCount++;
    const detEnter = r.detVerdict !== null;
    const llmEnter = r.llmVerdict.action === 'enter';
    if (llmEnter) confianzaDist[r.llmVerdict.confianza] = (confianzaDist[r.llmVerdict.confianza] ?? 0) + 1;
    if (llmEnter && detEnter) {
      agreeEnter++; agreeEnterN++;
      sumLlm += r.llmVerdict.sizingFactor; sumDet += r.detVerdict!.sizingFactor;
      if (r.positionClosed && r.realizedPnl !== null && r.detVerdict!.sizingFactor > 0) {
        detPnl += r.realizedPnl;
        llmPnl += r.realizedPnl * (r.llmVerdict.sizingFactor / r.detVerdict!.sizingFactor);
        closedCount++;
      }
    } else if (!llmEnter && !detEnter) agreeSkip++;
    else if (!llmEnter && detEnter) llmSkipDetEnter++;
    else llmEnterDetSkip++;
  }

  return {
    total, agreeEnter, agreeSkip, llmSkipDetEnter, llmEnterDetSkip,
    agreementRate: total === 0 ? 0 : (agreeEnter + agreeSkip) / total,
    confianzaDist,
    avgSizingLlm: agreeEnterN === 0 ? null : sumLlm / agreeEnterN,
    avgSizingDet: agreeEnterN === 0 ? null : sumDet / agreeEnterN,
    escalatedCount, escalationRate: total === 0 ? 0 : escalatedCount / total,
    sizingEdge: closedCount === 0 ? null : { detPnl, llmPnl, edge: llmPnl - detPnl, closedCount },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reasoning/shadow-report.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/shadow-report.ts src/lib/reasoning/shadow-report.test.ts
git commit -m "feat: computeShadowReport (agregación A/B pura, SP10)"
```

---

### Task 7: CLI `npm run shadow-report` + smoke

**Files:**
- Create: `src/cli/shadow-report.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getShadowVsDeterministic` (Task 5), `computeShadowReport`/`ShadowReport` (Task 6).
- Produces: CLI ejecutable `npm run shadow-report`. Sin test unit (la lógica vive en libs ya testeadas; el CLI es glue + salida); validado por typecheck + ejecución manual.

> Patrón de CLI existente: `src/cli/backtest.ts` corrido con `node --experimental-strip-types`.

- [ ] **Step 1: Crear `src/cli/shadow-report.ts`**

```ts
// src/cli/shadow-report.ts
// CLI read-only: imprime el reporte A/B (LLM sombra vs determinista). No muta nada.
import { getShadowVsDeterministic } from '../db/repositories/shadow-report-query.ts';
import { computeShadowReport } from '../lib/reasoning/shadow-report.ts';
import { pool } from '../db/pool.ts';

async function main(): Promise<void> {
  const rows = await getShadowVsDeterministic();
  const r = computeShadowReport(rows);
  const out = [
    '=== Reporte A/B: LLM (sombra) vs determinista ===',
    `Total señales con veredicto LLM: ${r.total}`,
    '',
    'Acuerdo de acción:',
    `  ambos enter:        ${r.agreeEnter}`,
    `  ambos skip:         ${r.agreeSkip}`,
    `  LLM skip / det enter: ${r.llmSkipDetEnter}`,
    `  LLM enter / det skip: ${r.llmEnterDetSkip}  (sin P&L observado)`,
    `  tasa de acuerdo:    ${(r.agreementRate * 100).toFixed(1)}%`,
    '',
    `Confianza LLM (en enters): ${JSON.stringify(r.confianzaDist)}`,
    `Sizing medio (agree-enter): LLM=${r.avgSizingLlm?.toFixed(3) ?? 'n/a'}  det=${r.avgSizingDet?.toFixed(3) ?? 'n/a'}`,
    `Escalación a Opus: ${r.escalatedCount}/${r.total} (${(r.escalationRate * 100).toFixed(1)}%)`,
    '',
    'Edge de SIZING (solo agree-enter cerrados; NO modela divergencia SL/TP del LLM):',
    r.sizingEdge
      ? `  det P&L=${r.sizingEdge.detPnl.toFixed(2)}  LLM P&L=${r.sizingEdge.llmPnl.toFixed(2)}  edge=${r.sizingEdge.edge.toFixed(2)}  (n=${r.sizingEdge.closedCount})`
      : '  (sin posiciones cerradas en agree-enter)',
  ].join('\n');
  process.stdout.write(out + '\n');
  await pool.end();
}

// v8 ignore next 4 — bloque de arranque CLI
main().catch((err) => {
  process.stderr.write(`shadow-report falló: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Añadir script a `package.json`**

En `"scripts"`, tras `"backtest"`, añade:

```json
    "shadow-report": "node --env-file=.env --experimental-strip-types src/cli/shadow-report.ts",
```

(Usa `--env-file=.env` para que `DATABASE_URL` esté disponible, igual que el smoke.)

- [ ] **Step 3: Typecheck + suite + ejecución del CLI**

Run: `npm run typecheck && npm test`
Expected: typecheck limpio; suite verde; cobertura ≥ 80%.

Run (manual, requiere Postgres del compose): `npm run shadow-report`
Expected: imprime el reporte sin error (con los datos actuales, probablemente `Total 0` si la tabla está vacía — válido; el formato debe renderizar sin lanzar).

- [ ] **Step 4: Commit**

```bash
git add src/cli/shadow-report.ts package.json
git commit -m "feat: CLI npm run shadow-report (reporte A/B read-only, SP10)"
```

- [ ] **Step 5: Smoke vivo (manual — escalación + risk-policy + A/B end-to-end)**

Requiere `DATABASE_URL`, `REDIS`, `ANTHROPIC_API_KEY`. Siembra una señal **BTC/USDT con funding extremo**
(`fundingZ=2.5`): el técnico la lee `bullish` (pullback alcista) y el fundamental `bearish`/`crowded_long`
(hacinamiento) → **analistas opuestos → `shouldEscalate=true`** → pasada Opus.

Run: `SHADOW_WORKER= npx flue run decision-maker --target node --input '{"signalId":"<signalId BTC funding extremo>"}'`
Expected: `outcome=persisted`. En `shadow_verdicts`: `escalated=true`, `model_used` = Opus
(`anthropic/claude-opus-4-6` o el id que resuelva), y un `sizingFactor` **prudente** (risk-policy +
hacinamiento). Verifica:
`psql "$DATABASE_URL" -c "SELECT escalated, model_used, verdict->>'sizingFactor', verdict->>'confianza' FROM kairos.shadow_verdicts ORDER BY created_at DESC LIMIT 1;"`

> **Si la pasada Opus falla** (id de Opus no resuelve en el catálogo de Pi): la fila tendrá
> `escalated=false`, `model_used`=Sonnet, y un audit `escalation_failed`. En ese caso, ajusta
> `ESCALATION_MODEL` en `.env` al id de Opus correcto (verificar con `flue dev` / catálogo) y repite.

Luego corre el reporte: `npm run shadow-report` — debe mostrar la señal escalada en `escalationRate`.

> Limpieza tras el smoke: borrar la señal sintética + su `shadow_verdicts` (y cualquier `decisions`/
> `positions` si se crearon) del dev DB, como en SP8/SP9.

---

## Notas de cierre (post-implementación)

Tras Task 7, actualizar (commit aparte): `CLAUDE.md` (bullet SP10 — cierre del núcleo de Fase 2) y el
ledger de SDD. SP10 cierra el núcleo (SP7→SP10); queda SP11 (control WhatsApp, separable).
