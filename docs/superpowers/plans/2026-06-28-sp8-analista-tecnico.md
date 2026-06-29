# SP8 — Analista técnico (subagente) + skill `technical-read` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El decision-maker delega la lectura técnica a un subagente Haiku (solo lectura) vía `session.task` antes de sintetizar su veredicto; el `technical_read` estructurado enriquece el veredicto y se persiste en `shadow_verdicts` para A/B. Todo en sombra sobre `sim`.

**Architecture:** Paso previo determinista en `runDecisionMaker`: el código llama `deps.analyze(args)` (subagente, sesión dedicada) con degradación, mete el `technical_read` en los `args` del `decision-protocol`, y persiste read+veredicto en un solo INSERT. El camino del dinero (`evaluateCandidate`) queda intacto y sin LLM. Mismo molde de deps inyectables que SP7 → la suite unit no llama al modelo.

**Tech Stack:** TypeScript (Node target de Flue), Flue 1.0.0-beta.5 (`defineAgentProfile`/`subagents`/`session.task`), Valibot, Postgres (esquema `kairos`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-28-sp8-analista-tecnico-design.md` (hallazgos de revisión R1–R5 ya incorporados).

## Global Constraints

- **Línea roja:** el subagente analista lleva `tools: []` — ninguna tool de mutación ni de lectura-con-efecto. El LLM juzga, no gatilla.
- **Verifica la API de Flue contra su doc real** (`node_modules/@flue/runtime/docs/`), nunca de memoria. Hechos ya verificados: `session.task(text, { agent, result, model }) → { data, usage, model }`; `harness.session(name?)` obtiene/crea sesión nombrada; subagente = `defineAgentProfile` en `subagents:[]`, `skills`/`tools` propios del profile, `model`/`thinkingLevel` heredan si se omiten.
- **Validación con Valibot** (no zod) para todo schema.
- **Camino del dinero intacto:** `evaluateCandidate` no se toca; sigue sin LLM.
- **Idempotencia sin cambios:** `jobId = signalId` + `UNIQUE(signal_id)` en `shadow_verdicts`; el `technical_read` va en el **mismo INSERT** del veredicto.
- **Best-effort / degradación:** fallo del analista → `technical_read=null` + audit `technical_read_failed`, el veredicto se emite igual. Nunca rompe el shadow ni el money path. Fallo de infra en `persist` propaga (run de Flue `failed`), como en SP7.
- **Modelo del analista por env:** `TECHNICAL_MODEL ?? 'anthropic/claude-haiku-4-5'`, `thinkingLevel: 'medium'` (explícitos en el profile para no heredar Sonnet/high del padre).
- **Flue descubre TODO `.ts` plano** en `src/workflows|channels|agents/` → no poner `.test.ts` ni no-workflows ahí.
- **Estilo:** funciones <50 líneas, archivos <800, inmutabilidad por defecto, validación en los límites, sin secretos hardcodeados, sin `console.log` de debug. Español en docs/comentarios; identificadores en su forma original.
- **Cobertura ≥ 80%**; `npm run typecheck` en verde.

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/lib/reasoning/technical-read-schema.ts` | Contrato Valibot `TechnicalReadSchema` + `parseTechnicalRead` | Crear |
| `src/lib/reasoning/technical-read-schema.test.ts` | Tests del schema | Crear |
| `src/db/schema.sql` | Columnas `technical_read`/`technical_model`/`technical_tokens` en `shadow_verdicts` | Modificar |
| `src/db/repositories/shadow-verdicts.ts` | `ShadowVerdictRow` + INSERT + `getShadowVerdict` extendidos | Modificar |
| `src/db/repositories/shadow-verdicts.test.ts` | Round-trip con los 3 campos nuevos | Modificar |
| `src/lib/reasoning/evaluate-with-failover.ts` | Exportar `extractTokens` (DRY) | Modificar |
| `src/lib/reasoning/analyze-technical.ts` | `analyzeTechnical(session, args, model)` vía `session.task` + interfaz `TaskSession` | Crear |
| `src/lib/reasoning/analyze-technical.test.ts` | Tests con `TaskSession` falsa | Crear |
| `src/lib/reasoning/run-decision-maker.ts` | Paso `analyze` con degradación; `ShadowEvalArgs`/`DecisionMakerDeps` extendidos; R3 en `shadow_failed` | Modificar |
| `src/lib/reasoning/run-decision-maker.test.ts` | Tests de degradación + persistencia del read | Modificar |
| `src/skills/technical-read/SKILL.md` | Doctrina del analista técnico (§16.5) | Crear |
| `src/skills/decision-protocol/SKILL.md` | Documenta `technical_read` en args + instrucción R1 (no delegar) | Modificar |
| `src/workflows/decision-maker.ts` | Profile `technical-analyst` + `subagents:[]` + sesión dedicada + wiring `analyze` | Modificar |

---

### Task 1: Contrato `TechnicalReadSchema`

**Files:**
- Create: `src/lib/reasoning/technical-read-schema.ts`
- Test: `src/lib/reasoning/technical-read-schema.test.ts`

**Interfaces:**
- Consumes: nada (hoja del grafo).
- Produces: `TechnicalReadSchema` (Valibot), `type TechnicalRead = v.InferOutput<typeof TechnicalReadSchema>`, `parseTechnicalRead(raw: unknown): TechnicalRead`. Campos: `bias: 'bullish'|'neutral'|'bearish'`, `confluence: 'strong'|'moderate'|'weak'`, `regime: 'trending'|'ranging'`, `divergence: 'none'|'bullish'|'bearish'`, `mtfNote: string` (minLength 1), `notes: string` (minLength 1).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reasoning/technical-read-schema.test.ts
import { describe, test, expect } from 'vitest';
import { parseTechnicalRead, TechnicalReadSchema } from './technical-read-schema.ts';
import * as v from 'valibot';

const VALID = {
  bias: 'bullish', confluence: 'strong', regime: 'trending',
  divergence: 'none', mtfNote: '4h alcista alinea con 15m', notes: 'EMA stack alcista y RSI sano',
};

describe('TechnicalReadSchema', () => {
  test('acepta un read válido', () => {
    expect(parseTechnicalRead(VALID)).toEqual(VALID);
  });

  test('rechaza bias fuera del picklist', () => {
    expect(() => parseTechnicalRead({ ...VALID, bias: 'moon' })).toThrow();
  });

  test('rechaza mtfNote vacío (minLength 1)', () => {
    expect(() => parseTechnicalRead({ ...VALID, mtfNote: '' })).toThrow();
  });

  test('rechaza notes ausente', () => {
    const { notes, ...sinNotes } = VALID;
    expect(() => parseTechnicalRead(sinNotes)).toThrow();
  });

  test('el schema infiere los 6 campos', () => {
    expect(Object.keys(TechnicalReadSchema.entries).sort()).toEqual(
      ['bias', 'confluence', 'divergence', 'mtfNote', 'notes', 'regime'],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/reasoning/technical-read-schema.test.ts`
Expected: FAIL — `Cannot find module './technical-read-schema.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/reasoning/technical-read-schema.ts
import * as v from 'valibot';

// Lectura técnica cualitativa del subagente analista (§16.5). Categóricos para que el A/B (SP10)
// los agregue; mtfNote/notes libres y auditables. El analista JUZGA el snapshot ya computado, no
// recalcula indicadores.
export const TechnicalReadSchema = v.object({
  bias: v.picklist(['bullish', 'neutral', 'bearish']),       // lectura direccional
  confluence: v.picklist(['strong', 'moderate', 'weak']),    // cuántas familias apuntan igual
  regime: v.picklist(['trending', 'ranging']),               // ADX/BB
  divergence: v.picklist(['none', 'bullish', 'bearish']),    // precio vs momentum
  mtfNote: v.pipe(v.string(), v.minLength(1)),               // lectura de la alineación MTF
  notes: v.pipe(v.string(), v.minLength(1)),                 // 1-3 frases cualitativas
});

export type TechnicalRead = v.InferOutput<typeof TechnicalReadSchema>;

export function parseTechnicalRead(raw: unknown): TechnicalRead {
  return v.parse(TechnicalReadSchema, raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/reasoning/technical-read-schema.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/technical-read-schema.ts src/lib/reasoning/technical-read-schema.test.ts
git commit -m "feat: TechnicalReadSchema (contrato Valibot del analista técnico, SP8)"
```

---

### Task 2: Persistencia del `technical_read` en `shadow_verdicts`

**Files:**
- Modify: `src/db/schema.sql:30-40` (tabla `shadow_verdicts`)
- Modify: `src/db/repositories/shadow-verdicts.ts`
- Test: `src/db/repositories/shadow-verdicts.test.ts` (integración, toca Postgres)

**Interfaces:**
- Consumes: nada de tareas previas (el `technical_read` se guarda como `jsonb`, tipo `unknown` en el row).
- Produces: `ShadowVerdictRow` extendido con `technicalRead: unknown | null`, `technicalModel: string | null`, `technicalTokens: number | null`. `insertShadowVerdict(row, exec?)` y `getShadowVerdict(signalId, exec?)` manejan los 3 campos. Tarea 4 (`run-decision-maker`) construye este row.

> **Nota:** `src/db/migrate.test.ts` valida **nombres de tablas** (no columnas de `shadow_verdicts`), así que añadir columnas no lo rompe — no se toca.

- [ ] **Step 1: Write the failing test (extiende el round-trip existente)**

En `src/db/repositories/shadow-verdicts.test.ts`, reemplaza el cuerpo del test `'insert + get round-trip; isAlreadyEvaluated'` por esta versión que afirma los 3 campos nuevos, y añade un test de degradado (campos null):

```ts
  test('insert + get round-trip; isAlreadyEvaluated', async () => {
    const signalId = await seedSignal();
    expect(await isAlreadyEvaluated(signalId)).toBe(false);
    await insertShadowVerdict({
      signalId, verdict: { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' },
      confianza: 'media', razonamiento: 'x', modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 1234,
      technicalRead: { bias: 'bullish', confluence: 'strong', regime: 'trending', divergence: 'none', mtfNote: 'm', notes: 'n' },
      technicalModel: 'anthropic/claude-haiku-4-5', technicalTokens: 321,
    });
    expect(await isAlreadyEvaluated(signalId)).toBe(true);
    const row = await getShadowVerdict(signalId);
    expect(row?.modelUsed).toBe('anthropic/claude-sonnet-4-6');
    expect(row?.tokens).toBe(1234);
    expect((row?.verdict as { action: string }).action).toBe('enter');
    expect((row?.technicalRead as { bias: string }).bias).toBe('bullish');
    expect(row?.technicalModel).toBe('anthropic/claude-haiku-4-5');
    expect(row?.technicalTokens).toBe(321);
  });

  test('analista degradado: technical_* null se persiste y se lee como null', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict({
      signalId, verdict: {}, confianza: 'baja', razonamiento: null, modelUsed: 'm', tokens: null,
      technicalRead: null, technicalModel: null, technicalTokens: null,
    });
    const row = await getShadowVerdict(signalId);
    expect(row?.technicalRead).toBeNull();
    expect(row?.technicalModel).toBeNull();
    expect(row?.technicalTokens).toBeNull();
  });
```

Y reemplaza el test `'ON CONFLICT DO NOTHING...'` (líneas 36-43) por esta versión, con los 3 campos nuevos en ambas llamadas para que compile:

```ts
  test('ON CONFLICT DO NOTHING: reinsertar la misma señal no duplica ni lanza', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict({ signalId, verdict: {}, confianza: 'alta', razonamiento: null, modelUsed: 'm', tokens: null,
      technicalRead: null, technicalModel: null, technicalTokens: null });
    await insertShadowVerdict({ signalId, verdict: {}, confianza: 'baja', razonamiento: null, modelUsed: 'm2', tokens: null,
      technicalRead: null, technicalModel: null, technicalTokens: null });
    const rows = await query(`SELECT confianza FROM kairos.shadow_verdicts WHERE signal_id=$1`, [signalId]);
    expect(rows.length).toBe(1);
    expect((rows[0] as { confianza: string }).confianza).toBe('alta'); // la primera gana
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/shadow-verdicts.test.ts`
Expected: FAIL — error de tipo (`technicalRead` no existe en `ShadowVerdictRow`) o columna inexistente en el INSERT.

- [ ] **Step 3: Modify `schema.sql`**

Reemplaza la definición de `shadow_verdicts` (líneas 30-40) por esta, que incluye las columnas nuevas en el CREATE (instalación fresca) y un ALTER idempotente (DB existente):

```sql
CREATE TABLE IF NOT EXISTS kairos.shadow_verdicts (
  id               text PRIMARY KEY,
  signal_id        text NOT NULL REFERENCES kairos.signals(id),
  verdict          jsonb NOT NULL,
  confianza        text NOT NULL,
  razonamiento     text,
  model_used       text,
  tokens           integer,
  technical_read   jsonb,      -- TechnicalRead del analista; null si degradado
  technical_model  text,       -- model.provider/id del analista
  technical_tokens integer,    -- usage del analista
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id)
);
-- Upgrade idempotente para DBs creadas antes de SP8:
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS technical_read   jsonb;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS technical_model  text;
ALTER TABLE kairos.shadow_verdicts ADD COLUMN IF NOT EXISTS technical_tokens integer;
```

- [ ] **Step 4: Modify the repo**

Reemplaza `src/db/repositories/shadow-verdicts.ts` por:

```ts
import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface ShadowVerdictRow {
  signalId: string;
  verdict: unknown;
  confianza: string;
  razonamiento: string | null;
  modelUsed: string | null;
  tokens: number | null;
  technicalRead: unknown | null;
  technicalModel: string | null;
  technicalTokens: number | null;
}

// Append-first; ON CONFLICT (signal_id) DO NOTHING hace la inserción idempotente ante carreras.
// El technical_read va en el MISMO INSERT del veredicto (no hay segunda fila ni segunda capa).
export async function insertShadowVerdict(row: ShadowVerdictRow, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.shadow_verdicts
       (id, signal_id, verdict, confianza, razonamiento, model_used, tokens,
        technical_read, technical_model, technical_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (signal_id) DO NOTHING`,
    [ulid(), row.signalId, JSON.stringify(row.verdict), row.confianza, row.razonamiento, row.modelUsed, row.tokens,
     row.technicalRead === null ? null : JSON.stringify(row.technicalRead), row.technicalModel, row.technicalTokens],
  );
}

export async function isAlreadyEvaluated(signalId: string, exec: Executor = query): Promise<boolean> {
  const rows = await exec(`SELECT 1 FROM kairos.shadow_verdicts WHERE signal_id = $1 LIMIT 1`, [signalId]);
  return rows.length > 0;
}

interface ShadowRow {
  signal_id: string; verdict: unknown; confianza: string; razonamiento: string | null;
  model_used: string | null; tokens: number | null;
  technical_read: unknown | null; technical_model: string | null; technical_tokens: number | null;
}

export async function getShadowVerdict(signalId: string, exec: Executor = query): Promise<ShadowVerdictRow | null> {
  const rows = await exec<ShadowRow>(
    `SELECT signal_id, verdict, confianza, razonamiento, model_used, tokens,
            technical_read, technical_model, technical_tokens
       FROM kairos.shadow_verdicts WHERE signal_id = $1`,
    [signalId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    signalId: r.signal_id, verdict: r.verdict, confianza: r.confianza, razonamiento: r.razonamiento,
    modelUsed: r.model_used, tokens: r.tokens === null ? null : Number(r.tokens),
    technicalRead: r.technical_read, technicalModel: r.technical_model,
    technicalTokens: r.technical_tokens === null ? null : Number(r.technical_tokens),
  };
}
```

- [ ] **Step 5: Run migrate + test to verify it passes**

Run: `npm run migrate && npx vitest run src/db/repositories/shadow-verdicts.test.ts`
Expected: migrate aplica los ALTER sin error; tests PASS (3/3, incluye degradado).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/repositories/shadow-verdicts.ts src/db/repositories/shadow-verdicts.test.ts
git commit -m "feat: shadow_verdicts persiste technical_read/model/tokens (SP8)"
```

> **Estado intermedio esperado (L1):** tras este commit, `ShadowVerdictRow` tiene 3 campos
> requeridos que el `run-decision-maker.ts` de SP7 aún no provee → `npm run typecheck` **fallará**
> hasta Task 4 (que reemplaza ese archivo). `npm test` (Vitest) sigue verde porque no hace
> typecheck de proyecto. No corras `npm run typecheck` como gate entre Task 2 y Task 4.

---

### Task 3: `analyzeTechnical` (delegación al subagente)

**Files:**
- Modify: `src/lib/reasoning/evaluate-with-failover.ts` (exportar `extractTokens`)
- Create: `src/lib/reasoning/analyze-technical.ts`
- Test: `src/lib/reasoning/analyze-technical.test.ts`

**Interfaces:**
- Consumes: `TechnicalReadSchema`, `type TechnicalRead` (Task 1); `extractTokens` de `evaluate-with-failover.ts`.
- Produces: `interface TaskSession { task(text: string, opts: { agent: string; result: unknown; model?: string }): Promise<{ data: TechnicalRead; usage: unknown; model: { provider: string; id: string } }> }` y `analyzeTechnical(session: TaskSession, args: Record<string, unknown>, model?: string): Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }>`. Tarea 4 consume `analyzeTechnical`; Tarea 5 implementa `TaskSession` con `harness.session('technical')`.

- [ ] **Step 1: Exportar `extractTokens` (DRY)**

En `src/lib/reasoning/evaluate-with-failover.ts`, cambia `function extractTokens` por `export function extractTokens` (línea 15). Es la misma función; se reutiliza en `analyze-technical.ts` para no duplicar la lógica de lectura de `totalTokens`.

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/reasoning/analyze-technical.test.ts
import { describe, test, expect, vi } from 'vitest';
import { analyzeTechnical, type TaskSession } from './analyze-technical.ts';
import type { TechnicalRead } from './technical-read-schema.ts';

const READ: TechnicalRead = {
  bias: 'bullish', confluence: 'moderate', regime: 'trending',
  divergence: 'none', mtfNote: '4h y 15m alinean', notes: 'momentum sano',
};

function fakeSession(over: Partial<TaskSession> = {}): TaskSession {
  return {
    task: vi.fn(async () => ({ data: READ, usage: { totalTokens: 222 }, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } })),
    ...over,
  };
}

describe('analyzeTechnical', () => {
  test('delega a technical-analyst y mapea read/modelUsed/tokens', async () => {
    const s = fakeSession();
    const out = await analyzeTechnical(s, { symbol: 'BTC/USDT', snapshot: {} }, 'anthropic/claude-haiku-4-5');
    expect(out.read).toEqual(READ);
    expect(out.modelUsed).toBe('anthropic/claude-haiku-4-5');
    expect(out.tokens).toBe(222);
    expect(s.task).toHaveBeenCalledWith(
      expect.stringContaining('BTC/USDT'),
      // result: debe ir siempre — fuerza la salida estructurada Valibot (no degradar el contrato).
      expect.objectContaining({ agent: 'technical-analyst', model: 'anthropic/claude-haiku-4-5', result: expect.anything() }),
    );
  });

  test('propaga el error del task (la degradación la maneja el llamador)', async () => {
    const s = fakeSession({ task: async () => { throw new Error('haiku caído'); } });
    await expect(analyzeTechnical(s, { symbol: 'X' })).rejects.toThrow('haiku caído');
  });

  test('tokens null cuando usage no trae totalTokens', async () => {
    const s = fakeSession({ task: async () => ({ data: READ, usage: {}, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } }) });
    const out = await analyzeTechnical(s, { symbol: 'X' });
    expect(out.tokens).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/reasoning/analyze-technical.test.ts`
Expected: FAIL — `Cannot find module './analyze-technical.ts'`.

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/reasoning/analyze-technical.ts
import { TechnicalReadSchema, type TechnicalRead } from './technical-read-schema.ts';
import { extractTokens } from './evaluate-with-failover.ts';

// Interfaz mínima de la sesión para delegar al subagente (subset de FlueSession.task con result).
// La real viene de harness.session('technical'); en tests se inyecta una falsa.
export interface TaskSession {
  task(text: string, opts: { agent: string; result: unknown; model?: string }): Promise<{
    data: TechnicalRead;
    usage: unknown;
    model: { provider: string; id: string };
  }>;
}

// El subagente recibe el snapshot ya computado en el texto del prompt; su skill `technical-read`
// (en su profile) le dice CÓMO interpretarlo. Juzga, no calcula. Sin failover propio en SP8 —
// la degradación la maneja runDecisionMaker (best-effort).
export async function analyzeTechnical(
  session: TaskSession, args: Record<string, unknown>, model?: string,
): Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }> {
  const text =
    'Evalúa la lectura técnica de este candidato y emite el technical_read estructurado ' +
    'según el protocolo del skill technical-read.\n\nDatos del candidato (snapshot ya computado):\n' +
    JSON.stringify(args);
  const res = await session.task(text, { agent: 'technical-analyst', result: TechnicalReadSchema, model });
  return { read: res.data, modelUsed: `${res.model.provider}/${res.model.id}`, tokens: extractTokens(res.usage) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/reasoning/analyze-technical.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reasoning/evaluate-with-failover.ts src/lib/reasoning/analyze-technical.ts src/lib/reasoning/analyze-technical.test.ts
git commit -m "feat: analyzeTechnical delega al subagente técnico vía session.task (SP8)"
```

---

### Task 4: Orquestación — paso `analyze` con degradación en `runDecisionMaker`

**Files:**
- Modify: `src/lib/reasoning/run-decision-maker.ts`
- Test: `src/lib/reasoning/run-decision-maker.test.ts`

**Interfaces:**
- Consumes: `type TechnicalRead` (Task 1); `ShadowVerdictRow` con campos `technical*` (Task 2); la forma de retorno de `analyzeTechnical` (Task 3): `{ read, modelUsed, tokens }`.
- Produces: `ShadowEvalArgs` gana `technical_read?: TechnicalRead | null`. `DecisionMakerDeps` gana `analyze: (args: ShadowEvalArgs) => Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }>`. El flujo: build args → `analyze` (degrada a null + audit `technical_read_failed`) → `evaluate({ ...args, technical_read })` → `persist` con read/model/tokens; en `shadow_failed`, el payload incluye read/tokens (R3). Tarea 5 cablea `analyze`.

- [ ] **Step 1: Write the failing tests (añade al describe existente)**

Añade estos tests a `src/lib/reasoning/run-decision-maker.test.ts`. Primero extiende el helper `deps()` para incluir `analyze` por defecto y un `READ` canónico (colócalo junto a las constantes de cabecera):

```ts
import type { TechnicalRead } from './technical-read-schema.ts';
const READ: TechnicalRead = { bias: 'bullish', confluence: 'strong', regime: 'trending', divergence: 'none', mtfNote: 'm', notes: 'n' };
```

En `deps()`, agrega dentro del objeto retornado (antes del `...over`):

```ts
    analyze: async () => ({ read: READ, modelUsed: 'anthropic/claude-haiku-4-5', tokens: 50 }),
```

Tests nuevos:

```ts
  test('camino feliz: persiste verdict + technical_read/model/tokens', async () => {
    const d = deps();
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({
      technicalRead: READ, technicalModel: 'anthropic/claude-haiku-4-5', technicalTokens: 50,
    }));
  });

  test('el technical_read viaja en los args de evaluate (clave snake_case)', async () => {
    const evaluate = vi.fn(async () => ({ verdict: VERDICT, modelUsed: 'm', tokens: 1 }));
    await runDecisionMaker('sig1', deps({ evaluate }));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ technical_read: READ }));
  });

  test('degradación: analista falla → technical_read null + audit, veredicto se emite igual', async () => {
    const d = deps({ analyze: async () => { throw new Error('haiku caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'technical_read_failed' }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ technicalRead: null, technicalModel: null, technicalTokens: null }));
  });

  test('R3: si evaluate falla tras analyze exitoso, shadow_failed lleva el read y tokens', async () => {
    const d = deps({ evaluate: async () => { throw new Error('sonnet caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('failed');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'shadow_failed',
      payload: expect.objectContaining({ technicalRead: READ, technicalTokens: 50, technicalModel: 'anthropic/claude-haiku-4-5' }),
    }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts`
Expected: FAIL — `analyze` no existe en `DecisionMakerDeps` / persist no recibe `technicalRead`.

- [ ] **Step 3: Write the implementation**

Reemplaza `src/lib/reasoning/run-decision-maker.ts` por:

```ts
import type { Signal, Strategy } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { ShadowVerdictRow } from '../../db/repositories/shadow-verdicts.ts';

export interface ShadowEvalArgs {
  symbol: string;
  snapshot: unknown;
  riskParams: Record<string, unknown>;
  timeframes: unknown;
  technical_read?: TechnicalRead | null;   // lo inyecta la orquestación tras analyze (clave snake → skill)
}

export interface DecisionMakerDeps {
  getSignal: (signalId: string) => Promise<Signal | null>;
  getStrategy: (strategyId: string) => Promise<Strategy | null>;
  isAlreadyEvaluated: (signalId: string) => Promise<boolean>;
  analyze: (args: ShadowEvalArgs) => Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }>;
  evaluate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
  persist: (row: ShadowVerdictRow) => Promise<void>;
  audit: (entry: { eventType: string; actor: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

export type DecisionOutcome =
  | { kind: 'persisted'; verdict: LlmVerdict }
  | { kind: 'not_found' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: string };

// Orquestación determinista del shadow eval. Pasos:
//   1. carga señal/estrategia (infra: propaga si falla);
//   2. analyze (subagente técnico) con DEGRADACIÓN best-effort: fallo → technical_read=null + audit;
//   3. evaluate (decision-protocol) con el read inyectado en args;
//   4. persist read+veredicto. SOLO el fallo de evaluate se traga como shadow_failed (con el read
//      para no perder costo/observabilidad, R3); persist propaga (infra), como en SP7.
export async function runDecisionMaker(signalId: string, deps: DecisionMakerDeps): Promise<DecisionOutcome> {
  const signal = await deps.getSignal(signalId);
  if (!signal) return { kind: 'not_found' };
  if (await deps.isAlreadyEvaluated(signalId)) return { kind: 'duplicate' };
  const strategy = await deps.getStrategy(signal.strategyId);
  if (!strategy) return { kind: 'not_found' };

  const args: ShadowEvalArgs = {
    symbol: signal.symbol,
    snapshot: signal.snapshot,
    riskParams: strategy.riskParams,
    timeframes: strategy.triggerConfig.timeframes,
  };

  // Paso 2: lectura técnica con degradación. El read es enriquecimiento, no dependencia dura.
  let technicalRead: TechnicalRead | null = null;
  let technicalModel: string | null = null;
  let technicalTokens: number | null = null;
  try {
    const a = await deps.analyze(args);
    technicalRead = a.read; technicalModel = a.modelUsed; technicalTokens = a.tokens;
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.name : 'unknown';
    try {
      await deps.audit({ eventType: 'technical_read_failed', actor: 'technical-analyst', payload: { signalId, error, errorType } });
    } catch { /* best-effort: ni el audit puede tumbar el shadow */ }
  }

  // Paso 3: veredicto, con el read inyectado en los args (snake_case → lo lee decision-protocol).
  const evalArgs: ShadowEvalArgs = { ...args, technical_read: technicalRead };
  let evaluated: { verdict: LlmVerdict; modelUsed: string; tokens: number | null };
  try {
    evaluated = await deps.evaluate(evalArgs);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await deps.audit({
        eventType: 'shadow_failed', actor: 'decision-maker',
        payload: { signalId, error, technicalRead, technicalModel, technicalTokens },  // R3
      });
    } catch { /* best-effort */ }
    return { kind: 'failed', error };
  }

  // persist FUERA del try: si la DB falla aquí, propaga (infra, no fallo de modelo) → run Flue 'failed'.
  await deps.persist({
    signalId, verdict: evaluated.verdict, confianza: evaluated.verdict.confianza,
    razonamiento: evaluated.verdict.razonamiento, modelUsed: evaluated.modelUsed, tokens: evaluated.tokens,
    technicalRead, technicalModel, technicalTokens,
  });
  return { kind: 'persisted', verdict: evaluated.verdict };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts`
Expected: PASS (todos: los 6 de SP7 siguen verdes + los 4 nuevos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/run-decision-maker.ts src/lib/reasoning/run-decision-maker.test.ts
git commit -m "feat: runDecisionMaker delega al técnico con degradación + R3 (SP8)"
```

---

### Task 5: Cableado del workflow + skills (profile, subagente, sesión dedicada)

**Files:**
- Create: `src/skills/technical-read/SKILL.md`
- Modify: `src/skills/decision-protocol/SKILL.md`
- Modify: `src/workflows/decision-maker.ts`

**Interfaces:**
- Consumes: `analyzeTechnical` + `TaskSession` (Task 3); `runDecisionMaker`/`DecisionMakerDeps`/`ShadowEvalArgs` (Task 4); `evaluateWithFailover`/`SkillSession` (SP7).
- Produces: workflow `decision-maker` cableado end-to-end. Sin test unit nuevo (la lógica vive en las libs ya testeadas); se valida con `typecheck` + smoke vivo. El profile `technical-analyst` lleva `tools: []` (línea roja) y `skills: [technicalRead]`.

> Recordatorio Flue-discovery: `decision-maker.ts` es descubierto como workflow. No añadir `.test.ts` ni helpers no-workflow en `src/workflows/` (regla del proyecto). El skill nuevo vive en `src/skills/technical-read/`, no en un dir descubierto.

- [ ] **Step 1: Crear `src/skills/technical-read/SKILL.md`**

```markdown
---
name: technical-read
description: Protocolo del analista técnico de Kairos para interpretar el snapshot de indicadores ya computado y emitir un technical_read cualitativo (sin recalcular indicadores).
---

# Lectura técnica (Kairos)

Eres el **analista técnico** de un bot de trading spot long-only. Recibes en el prompt un `snapshot`
de indicadores **ya calculados** por el scanner determinista. **No recalculas nada ni ejecutas
órdenes**: interpretas los números y emites un `technical_read` estructurado. *Juzgas, no calculas.*

## Entrada

- `symbol`: el par (p. ej. `BTC/USDT`).
- `snapshot`: indicadores por timeframe (`byTimeframe`), `mtfAlignment` (`aligned`/`mixed`/`counter`),
  `levels` (soporte/resistencia), `derivatives` (funding/OI).
- `riskParams`, `timeframes`: contexto de la estrategia (`bias`/`context`/`trigger`).

## Cómo leer

1. **Confluencia:** ¿varias familias (tendencia, momentum, volumen) apuntan en la misma dirección?
   Más confluencia → `confluence: strong`. Pocas o contradictorias → `weak`.
2. **Divergencia:** ¿el precio contradice al momentum (nuevo máximo sin nuevo máximo de RSI)? Marca
   `divergence: bearish` (resta convicción a un long) o `bullish`; si no hay, `none`.
3. **Régimen:** distingue tendencia de rango (ADX/Bollinger). `regime: trending` vs `ranging`.
4. **Alineación MTF:** `aligned` refuerza el `bias`; `mixed` pide cautela; `counter` es señal fuerte
   de cautela (el scanner ya filtra la mayoría). Resúmela en `mtfNote`.

## Salida (contrato)

Emite **solo** el objeto estructurado pedido:

- `bias`: `bullish`/`neutral`/`bearish` — lectura direccional del conjunto.
- `confluence`: `strong`/`moderate`/`weak`.
- `regime`: `trending`/`ranging`.
- `divergence`: `none`/`bullish`/`bearish`.
- `mtfNote`: 1 frase sobre la alineación multi-timeframe.
- `notes`: 1–3 frases cualitativas justificando el read con la evidencia concreta del snapshot.

No propones niveles ni sizing: eso es del decision-maker. Tu trabajo es la **lectura cualitativa**.
```

- [ ] **Step 2: Editar `src/skills/decision-protocol/SKILL.md` (documenta technical_read + R1)**

En la sección `## Entrada (`args`)`, añade un bullet:

```markdown
- `technical_read` *(opcional)*: lectura cualitativa de un analista técnico que ya interpretó el
  snapshot (`bias`, `confluence`, `regime`, `divergence`, `mtfNote`, `notes`). Es **un insumo más**,
  no un oráculo: pésalo junto a tu propia lectura del snapshot. Si **no** viene (analista degradado),
  razona sobre el snapshot directamente como siempre.
```

Y al final del documento, añade una nota explícita (R1 — evita que el modelo re-delegue):

```markdown
## Importante

El `technical_read`, cuando existe, **ya viene en `args`**. **No** delegues ni invoques ningún
subagente: tu trabajo es sintetizar el veredicto con la evidencia que ya tienes.
```

- [ ] **Step 3: Editar `src/workflows/decision-maker.ts` (profile + subagente + sesión dedicada)**

Reemplaza el archivo por:

```ts
import { defineAgent, defineAgentProfile, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import decisionProtocol from '../skills/decision-protocol/SKILL.md' with { type: 'skill' };
import technicalRead from '../skills/technical-read/SKILL.md' with { type: 'skill' };
import { evaluateWithFailover, type SkillSession } from '../lib/reasoning/evaluate-with-failover.ts';
import { analyzeTechnical, type TaskSession } from '../lib/reasoning/analyze-technical.ts';
import { runDecisionMaker, type DecisionMakerDeps } from '../lib/reasoning/run-decision-maker.ts';
import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { insertShadowVerdict, isAlreadyEvaluated } from '../db/repositories/shadow-verdicts.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Modelos por env (§9): no hardcodear el id exacto. Failover reintenta el mismo modelo si no hay escalación.
const DECISION_MODEL = process.env.DECISION_MODEL ?? 'anthropic/claude-sonnet-4-6';
const ESCALATION = process.env.DECISION_MODEL_ESCALATION;
const MODELS = ESCALATION ? [DECISION_MODEL, ESCALATION] : [DECISION_MODEL, DECISION_MODEL];
// Analista técnico: Haiku, thinking medium (ARCHITECTURE §287). Explícito para NO heredar Sonnet/high.
const TECHNICAL_MODEL = process.env.TECHNICAL_MODEL ?? 'anthropic/claude-haiku-4-5';

// Subagente técnico: SOLO lectura del snapshot que recibe en el prompt. tools:[] = línea roja
// (no puede mutar dinero ni leer-con-efecto). Su skill technical-read le da la doctrina.
const technicalAnalyst = defineAgentProfile({
  name: 'technical-analyst',
  description: 'Interpreta el snapshot de indicadores ya computado y emite un technical_read cualitativo. Solo lectura.',
  model: TECHNICAL_MODEL,
  thinkingLevel: 'medium',
  skills: [technicalRead],
  tools: [],
});

const decisionAgent = defineAgent(() => ({
  model: DECISION_MODEL,
  thinkingLevel: 'high',
  skills: [decisionProtocol],
  subagents: [technicalAnalyst],
  // SIN tools de mutación: el decision-maker solo emite veredicto (línea roja).
}));

export default defineWorkflow({
  agent: decisionAgent,
  input: v.object({ signalId: v.string() }),
  output: v.object({ outcome: v.picklist(['persisted', 'not_found', 'duplicate', 'failed']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    // Sesión dedicada para el analista (R2): mantiene el transcript del decision-maker limpio y
    // determinista. El subagente está disponible porque se registra en el AGENTE, no en la sesión.
    const techSession = (await harness.session('technical')) as unknown as TaskSession;
    const deps: DecisionMakerDeps = {
      getSignal: getSignalById,
      getStrategy,
      isAlreadyEvaluated,
      analyze: (args) => analyzeTechnical(techSession, args as unknown as Record<string, unknown>, TECHNICAL_MODEL),
      evaluate: (args) => evaluateWithFailover(session, args as unknown as Record<string, unknown>, MODELS),
      persist: insertShadowVerdict,
      audit: appendAuditLog,
    };
    const result = await runDecisionMaker(input.signalId, deps);
    return { outcome: result.kind };
  },
});
```

> **Contingencia M1 (verificar en el smoke, Step 6):** la doc de Flue muestra `task({ agent })`
> sobre la sesión **default**; usar una sesión **nombrada** (`harness.session('technical')`) para
> delegar a un subagente es coherente (los subagentes son del *agente*, no de la sesión) pero no
> está demostrado con un ejemplo. Si el smoke falla con "subagente no encontrado" al llamar
> `techSession.task({ agent: 'technical-analyst' })`, la corrección es delegar desde la sesión
> **default** (`session`) en vez de `techSession` (`analyze: (args) => analyzeTechnical(session as
> unknown as TaskSession, ...)`), aceptando que el transcript del decision-maker reciba la ida/vuelta
> del analista como efecto colateral menor. Preferencia: sesión dedicada (R2); fallback documentado:
> sesión default.

- [ ] **Step 4: Typecheck + suite completa**

Run: `npm run typecheck && npm test`
Expected: typecheck limpio; toda la suite verde (incluye los tests nuevos de Tasks 1–4). Cobertura ≥ 80%.

- [ ] **Step 5: Commit**

```bash
git add src/skills/technical-read/SKILL.md src/skills/decision-protocol/SKILL.md src/workflows/decision-maker.ts
git commit -m "feat: cablea analista técnico en decision-maker (profile + skill + sesión dedicada, SP8)"
```

- [ ] **Step 6: Smoke vivo (manual, no determinista — requiere DATABASE_URL, REDIS y ANTHROPIC_API_KEY)**

Siembra una señal real (o reutiliza una de `kairos.signals`) y corre el workflow una vez:

Run: `npx flue run decision-maker --input '{"signalId":"<un signalId real de kairos.signals>"}'`
Expected: el run completa; en `kairos.shadow_verdicts` la fila de esa señal trae `technical_read`
(JSON con los 6 campos), `technical_model` (`anthropic/claude-haiku-4-5`) y `technical_tokens` no
nulos, además del `verdict`. Verifica con:
`psql "$DATABASE_URL" -c "SELECT technical_model, technical_tokens, technical_read->>'bias' FROM kairos.shadow_verdicts ORDER BY created_at DESC LIMIT 1;"`

> Si el analista falla (p. ej. modelo no disponible), la fila debe traer `technical_read` null y un
> audit `technical_read_failed` en `kairos.audit_log`, con el `verdict` igualmente persistido
> (degradación). Eso también es un resultado válido del smoke.

---

## Notas de cierre (post-implementación, fuera de los commits de tareas)

Tras Task 5, actualizar (en un commit aparte, como en SP6/SP7):
- `CLAUDE.md`: añadir bullet SP8 al progreso por sprints (analista técnico en sombra).
- `MEMORY.md` del proyecto: nota de avance de Fase 2 si aplica.
- El ledger de subagent-driven-development con el estado de cada tarea.
