# SP7 — Cimiento LLM + decision-maker en sombra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un candidato es evaluado por un decision-maker LLM (vía Flue) que emite un veredicto estructurado (Valibot), persistido **en sombra** junto al determinista para A/B, sin que el LLM toque el camino del dinero.

**Architecture:** el decision-maker es un `defineWorkflow` Flue cuyo `agent` registra el skill `decision-protocol`; su `run()` corre `session.skill('decision-protocol', { result })` con failover y persiste a `kairos.shadow_verdicts`. El money path (`worker.ts`) queda intacto; el `evaluate-worker` (capa BullMQ) encola un job `shadow-eval` best-effort tras cada evaluación; un worker de esa cola **dentro del runtime Flue** (`app.ts`) llama `invoke(decisionMaker, {signalId})` in-process. La lógica testeable (`runDecisionMaker`, `evaluateWithFailover`) se aísla con una sesión inyectable.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`), Flue 1.0.0-beta.5 (`@flue/runtime`, `defineWorkflow`/`defineAgent`/`session.skill`), Valibot, Postgres (esquema `kairos`), BullMQ + ioredis, Vitest. Spec: `docs/superpowers/specs/2026-06-28-sp7-cimiento-llm-shadow-design.md`.

## Global Constraints

- **Verifica la API de Flue contra su doc real** (`node_modules/@flue/runtime/docs/`), nunca de memoria. Hechos ya verificados: `session.skill(name, { args, result })` → `response.data` validado (lanza `ResultUnavailableError`); las sesiones vienen de `harness.session()` dentro de un workflow/agente; `invoke()` solo corre dentro del servidor Flue (`app.ts`); failover = `options.model` override; skills se importan `with { type: 'skill' }` y se registran en `skills:[]`.
- **El LLM nunca toca dinero:** ninguna tool de mutación en `tools:[]` del agente; el decision-maker solo emite un veredicto en sombra.
- **Best-effort:** un fallo del shadow eval se audita (`shadow_failed`) y se traga; jamás propaga al camino del dinero (igual que `notifyBestEffort`).
- **Idempotencia:** `jobId = signalId` en la cola shadow + `UNIQUE(signal_id)` en `shadow_verdicts` (insert con `ON CONFLICT DO NOTHING`).
- Imports ESM con extensión `.ts` explícita; `pg` devuelve `numeric` como string → `Number()`; funciones <50 líneas; sin `console.log`; inmutabilidad; español en comentarios/mensajes, identificadores en su forma.
- Modelos vía env (no hardcodear el id exacto de Opus, §9): `DECISION_MODEL` (default `anthropic/claude-sonnet-4-6`), `DECISION_MODEL_ESCALATION` (opcional; si no está, el failover reintenta el mismo modelo). Credencial: `ANTHROPIC_API_KEY` (ya en `.env.example`).
- Tests de integración tocan el Postgres del compose (`DATABASE_URL`); la suite unit NO toca Redis ni el modelo. Cobertura ≥ 80%. Correr un test: `npx vitest run <ruta>`; tipos: `npm run typecheck`.
- **Córrelo de verdad antes de afirmar que pasa.**

---

## File Structure

**Nuevos:**
- `src/db/repositories/shadow-verdicts.ts` — repo de `shadow_verdicts` (Task 1).
- `src/lib/reasoning/verdict-schema.ts` — `LlmVerdictSchema` + tipo (Task 2).
- `src/skills/decision-protocol/SKILL.md` — doctrina + contrato de salida (Task 2).
- `src/lib/reasoning/evaluate-with-failover.ts` — llamada LLM + failover, sesión inyectable (Task 3).
- `src/lib/reasoning/run-decision-maker.ts` — orquestación (load → evaluate → persist), best-effort (Task 4).
- `src/workflows/decision-maker.ts` — `defineWorkflow` que cablea harness→runDecisionMaker (Task 5).
- `src/lib/queue/shadow-queue.ts` — `buildShadowJob` + `enqueueShadowEval` (Task 6).
- `src/shadow/shadow-worker.ts` — `startShadowWorker()` (Worker BullMQ → `invoke`) (Task 7).

**Modificar:**
- `src/db/schema.sql` — tabla `shadow_verdicts` (Task 1).
- `src/lib/queue/evaluate-worker.ts` — encolar `shadow-eval` best-effort tras `evaluateCandidate` (Task 6).
- `src/app.ts` — arrancar el shadow worker (Task 7).

**Sin tocar:** `src/workflows/evaluate-candidate.ts` y su test (el money path no cambia).

---

## Task 1: Esquema y repo de `shadow_verdicts`

**Files:**
- Modify: `src/db/schema.sql` (tras la tabla `signals`, junto a las demás)
- Create: `src/db/repositories/shadow-verdicts.ts`
- Test: `src/db/repositories/shadow-verdicts.test.ts`

**Interfaces:**
- Consumes: `query`, `Executor` (de `../pool.ts`), `ulid`.
- Produces:
  - `interface ShadowVerdictRow { signalId: string; verdict: unknown; confianza: string; razonamiento: string | null; modelUsed: string | null; tokens: number | null }`
  - `insertShadowVerdict(row: ShadowVerdictRow, exec?): Promise<void>` (ON CONFLICT DO NOTHING)
  - `isAlreadyEvaluated(signalId: string, exec?): Promise<boolean>`
  - `getShadowVerdict(signalId: string, exec?): Promise<ShadowVerdictRow | null>`

- [ ] **Step 1: Añadir la tabla al esquema**

En `src/db/schema.sql`, tras la tabla `kairos.signals` (después de su índice, ~línea 26), añadir:

```sql
-- SP7: veredictos del decision-maker LLM en SOMBRA (Fase 2). Append-first; UNIQUE(signal_id)
-- deduplica el shadow eval al reintentar. Separada de `decisions` (camino determinista).
CREATE TABLE IF NOT EXISTS kairos.shadow_verdicts (
  id           text PRIMARY KEY,
  signal_id    text NOT NULL REFERENCES kairos.signals(id),
  verdict      jsonb NOT NULL,
  confianza    text NOT NULL,
  razonamiento text,
  model_used   text,
  tokens       integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id)
);
```

- [ ] **Step 2: Escribir el test**

Crear `src/db/repositories/shadow-verdicts.test.ts`:

```ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { insertShadowVerdict, isAlreadyEvaluated, getShadowVerdict } from './shadow-verdicts.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'SHADOWBTC/USDT';
const STRATEGY_ID = 'shadow-test-strategy';

async function seedSignal(): Promise<string> {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`, [STRATEGY_ID, `{${SYMBOL}}`]);
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-20T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  return insertSignal(signal);
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.shadow_verdicts WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('shadow_verdicts repo', () => {
  test('insert + get round-trip; isAlreadyEvaluated', async () => {
    const signalId = await seedSignal();
    expect(await isAlreadyEvaluated(signalId)).toBe(false);
    await insertShadowVerdict({ signalId, verdict: { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' }, confianza: 'media', razonamiento: 'x', modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 1234 });
    expect(await isAlreadyEvaluated(signalId)).toBe(true);
    const row = await getShadowVerdict(signalId);
    expect(row?.modelUsed).toBe('anthropic/claude-sonnet-4-6');
    expect(row?.tokens).toBe(1234);
    expect((row?.verdict as { action: string }).action).toBe('enter');
  });

  test('ON CONFLICT DO NOTHING: reinsertar la misma señal no duplica ni lanza', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict({ signalId, verdict: {}, confianza: 'alta', razonamiento: null, modelUsed: 'm', tokens: null });
    await insertShadowVerdict({ signalId, verdict: {}, confianza: 'baja', razonamiento: null, modelUsed: 'm2', tokens: null });
    const rows = await query(`SELECT confianza FROM kairos.shadow_verdicts WHERE signal_id=$1`, [signalId]);
    expect(rows.length).toBe(1);
    expect((rows[0] as { confianza: string }).confianza).toBe('alta'); // la primera gana
  });
});
```

- [ ] **Step 3: Correr y ver fallar**

Run: `npx vitest run src/db/repositories/shadow-verdicts.test.ts`
Expected: FAIL — el repo no existe.

- [ ] **Step 4: Implementar el repo**

Crear `src/db/repositories/shadow-verdicts.ts`:

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
}

// Append-first; ON CONFLICT (signal_id) DO NOTHING hace la inserción idempotente ante carreras.
export async function insertShadowVerdict(row: ShadowVerdictRow, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.shadow_verdicts (id, signal_id, verdict, confianza, razonamiento, model_used, tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (signal_id) DO NOTHING`,
    [ulid(), row.signalId, JSON.stringify(row.verdict), row.confianza, row.razonamiento, row.modelUsed, row.tokens],
  );
}

export async function isAlreadyEvaluated(signalId: string, exec: Executor = query): Promise<boolean> {
  const rows = await exec(`SELECT 1 FROM kairos.shadow_verdicts WHERE signal_id = $1 LIMIT 1`, [signalId]);
  return rows.length > 0;
}

interface ShadowRow { signal_id: string; verdict: unknown; confianza: string; razonamiento: string | null; model_used: string | null; tokens: number | null; }

export async function getShadowVerdict(signalId: string, exec: Executor = query): Promise<ShadowVerdictRow | null> {
  const rows = await exec<ShadowRow>(
    `SELECT signal_id, verdict, confianza, razonamiento, model_used, tokens FROM kairos.shadow_verdicts WHERE signal_id = $1`,
    [signalId],
  );
  const r = rows[0];
  if (!r) return null;
  return { signalId: r.signal_id, verdict: r.verdict, confianza: r.confianza, razonamiento: r.razonamiento,
    modelUsed: r.model_used, tokens: r.tokens === null ? null : Number(r.tokens) };
}
```

- [ ] **Step 5: Correr y ver pasar; typecheck**

Run: `npx vitest run src/db/repositories/shadow-verdicts.test.ts && npm run typecheck`
Expected: PASS, sin errores de tipo.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/repositories/shadow-verdicts.ts src/db/repositories/shadow-verdicts.test.ts
git commit -m "feat: tabla y repo shadow_verdicts (SP7 Task 1)"
```

---

## Task 2: `LlmVerdictSchema` + skill `decision-protocol`

**Files:**
- Create: `src/lib/reasoning/verdict-schema.ts`
- Create: `src/skills/decision-protocol/SKILL.md`
- Test: `src/lib/reasoning/verdict-schema.test.ts`

**Interfaces:**
- Produces: `LlmVerdictSchema` (Valibot), `type LlmVerdict`, `parseLlmVerdict(raw): LlmVerdict`.

- [ ] **Step 1: Escribir el test**

Crear `src/lib/reasoning/verdict-schema.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import * as v from 'valibot';
import { LlmVerdictSchema, parseLlmVerdict } from './verdict-schema.ts';

describe('LlmVerdictSchema', () => {
  test('acepta un veredicto válido', () => {
    const ok = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.5, confianza: 'media', razonamiento: 'confluencia alcista' };
    expect(parseLlmVerdict(ok)).toEqual(ok);
  });

  test('rechaza sizingFactor fuera de [0,1] y confianza inválida', () => {
    expect(() => parseLlmVerdict({ action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1.5, confianza: 'media', razonamiento: 'x' })).toThrow();
    expect(() => v.parse(LlmVerdictSchema, { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.5, confianza: 'altísima', razonamiento: 'x' })).toThrow();
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/reasoning/verdict-schema.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el schema**

Crear `src/lib/reasoning/verdict-schema.ts`:

```ts
import * as v from 'valibot';

// Veredicto del decision-maker LLM. Alineado con el Verdict determinista (action/entry/sl/tp/
// sizingFactor) para A/B directo, más los extras del LLM (confianza, razonamiento auditable).
// 'lado' (ARCHITECTURE §6) se omite: implícito 'long' (spot long-only); se añade con shorts.
export const LlmVerdictSchema = v.object({
  action: v.picklist(['enter', 'skip']),
  entry: v.number(),
  sl: v.number(),
  tp: v.number(),
  sizingFactor: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  confianza: v.picklist(['alta', 'media', 'baja']),
  razonamiento: v.string(),
});

export type LlmVerdict = v.InferOutput<typeof LlmVerdictSchema>;

export function parseLlmVerdict(raw: unknown): LlmVerdict {
  return v.parse(LlmVerdictSchema, raw);
}
```

- [ ] **Step 4: Correr y ver pasar**

Run: `npx vitest run src/lib/reasoning/verdict-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Crear el skill `decision-protocol`**

Crear `src/skills/decision-protocol/SKILL.md` (el frontmatter `name` DEBE ser `decision-protocol` = nombre del directorio; lowercase-hyphen):

```markdown
---
name: decision-protocol
description: Protocolo del decision-maker de Kairos para sintetizar la evidencia disponible de un candidato y emitir un veredicto estructurado de entrada (enter/skip) en spot long-only.
---

# Protocolo de decisión (Kairos)

Eres el **decision-maker** de un bot de trading spot long-only. Recibes en `args` la evidencia de
un candidato que el scanner determinista ya disparó. **No ejecutas órdenes**: solo emites un
veredicto estructurado que otra capa (determinista) podrá usar. Tu juicio nunca mueve dinero por sí
mismo.

## Entrada (`args`)

- `symbol`: el par (p. ej. `BTC/USDT`).
- `snapshot`: indicadores ya calculados por timeframe (`byTimeframe`), `mtfAlignment`
  (`aligned`/`mixed`/`counter`), `levels` (soporte/resistencia), `derivatives` (funding/OI).
- `riskParams`: parámetros de riesgo de la estrategia (incluye `atr_stop_mult`, `tp_r_multiple`).
- `timeframes`: `{ bias, context, trigger }`.

## Cómo razonar

1. **Confluencia:** ¿varias familias de indicadores apuntan en la misma dirección (tendencia,
   momentum, volumen)? Más confluencia → más convicción.
2. **Divergencia:** ¿el precio contradice al momentum (p. ej. nuevo máximo sin nuevo máximo de RSI)?
   La divergencia bajista resta convicción a una entrada larga.
3. **Régimen:** distingue tendencia de rango (ADX/Bollinger). En rango, sé más cauto con entradas de
   ruptura.
4. **Alineación MTF:** un `mtfAlignment` `counter` (gatillo contra el sesgo HTF) es una señal de
   cautela fuerte; `aligned` refuerza.
5. **Derivados:** funding/OI en extremo sugieren hacinamiento (riesgo de squeeze) → cautela.

## Salida (contrato)

Emite **solo** el objeto estructurado pedido (sin prosa libre fuera de `razonamiento`):

- `action`: `enter` si el conjunto justifica una entrada larga; `skip` si no.
- `entry`/`sl`/`tp`: niveles coherentes con `riskParams` (el SL respeta `atr_stop_mult`; el TP,
  `tp_r_multiple` sobre la distancia al SL). Usa el `close` del timeframe gatillo como referencia de
  `entry`.
- `sizingFactor`: en `[0,1]`. Reduce ante cautela (divergencia, contra-tendencia, derivados
  extremos). Nunca lo subas por encima de tu convicción real: un risk gate determinista lo capará
  de todas formas.
- `confianza`: `alta`/`media`/`baja`.
- `razonamiento`: 1–3 frases justificando el veredicto con la evidencia concreta.

Ante evidencia insuficiente o contradictoria, prefiere `skip` con `confianza: baja`.
```

- [ ] **Step 6: Typecheck del import del skill**

Para validar que Flue acepta el `SKILL.md` y su frontmatter, basta que un módulo lo importe; lo hará Task 5. Por ahora, verifica el schema:

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add src/lib/reasoning/verdict-schema.ts src/lib/reasoning/verdict-schema.test.ts src/skills/decision-protocol/SKILL.md
git commit -m "feat: LlmVerdictSchema + skill decision-protocol (SP7 Task 2)"
```

---

## Task 3: `evaluateWithFailover` (llamada LLM + failover, sesión inyectable)

**Files:**
- Create: `src/lib/reasoning/evaluate-with-failover.ts`
- Test: `src/lib/reasoning/evaluate-with-failover.test.ts`

**Interfaces:**
- Consumes: `LlmVerdictSchema`, `LlmVerdict`.
- Produces:
  - `interface SkillSession { skill(name: string, opts: { args: Record<string, unknown>; result: unknown; model?: string }): Promise<{ data: LlmVerdict; usage: unknown; model: { provider: string; id: string } }> }`
  - `evaluateWithFailover(session: SkillSession, args: Record<string, unknown>, models: string[]): Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>`

- [ ] **Step 1: Escribir el test**

Crear `src/lib/reasoning/evaluate-with-failover.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { evaluateWithFailover, type SkillSession } from './evaluate-with-failover.ts';
import type { LlmVerdict } from './verdict-schema.ts';

const VERDICT: LlmVerdict = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' };
function ok(model: string) { return { data: VERDICT, usage: { totalTokens: 50 }, model: { provider: model.split('/')[0], id: model.split('/')[1] } }; }

describe('evaluateWithFailover', () => {
  test('primer modelo OK → devuelve veredicto + modelUsed + tokens', async () => {
    const session: SkillSession = { skill: vi.fn(async (_n, opts) => ok(opts.model!)) };
    const r = await evaluateWithFailover(session, { symbol: 'BTC/USDT' }, ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-x']);
    expect(r.verdict).toEqual(VERDICT);
    expect(r.modelUsed).toBe('anthropic/claude-sonnet-4-6');
    expect(r.tokens).toBe(50);
    expect(session.skill).toHaveBeenCalledOnce(); // no escaló
  });

  test('primer modelo falla → reintenta el segundo', async () => {
    const skill = vi.fn()
      .mockRejectedValueOnce(new Error('provider 503'))
      .mockImplementationOnce(async (_n: string, opts: { model?: string }) => ok(opts.model!));
    const r = await evaluateWithFailover({ skill } as unknown as SkillSession, {}, ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-x']);
    expect(r.modelUsed).toBe('anthropic/claude-opus-x');
    expect(skill).toHaveBeenCalledTimes(2);
  });

  test('todos fallan → lanza el último error', async () => {
    const session: SkillSession = { skill: vi.fn(async () => { throw new Error('down'); }) };
    await expect(evaluateWithFailover(session, {}, ['a/b', 'c/d'])).rejects.toThrow('down');
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/reasoning/evaluate-with-failover.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/lib/reasoning/evaluate-with-failover.ts`:

```ts
import { LlmVerdictSchema, type LlmVerdict } from './verdict-schema.ts';

// Interfaz mínima de la sesión que necesitamos (subset de FlueSession.skill con result).
// La real viene de harness.session(); en tests se inyecta una falsa.
export interface SkillSession {
  skill(name: string, opts: { args: Record<string, unknown>; result: unknown; model?: string }): Promise<{
    data: LlmVerdict;
    usage: unknown;
    model: { provider: string; id: string };
  }>;
}

// Extrae el total de tokens de PromptUsage (`totalTokens` es el campo documentado; los fallbacks
// son conservadores ante versiones futuras).
function extractTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const t = u.totalTokens ?? u.total_tokens ?? u.tokens;
  return typeof t === 'number' ? t : null;
}

// Llama al skill decision-protocol probando los modelos en orden; devuelve el primer éxito.
// Failover = resiliencia ante error de proveedor o ResultUnavailableError (Sonnet→Opus si se
// configuró DECISION_MODEL_ESCALATION; si no, reintenta el mismo modelo).
// SP7: ambos intentos comparten la `session`; si el primero falla con ResultUnavailableError, el
// turno fallido queda en el historial y llega al reintento. Tolerable en sombra/best-effort; la
// sesión fresca por intento (sessionFactory) se introduce en SP10 cuando el failover pese más.
export async function evaluateWithFailover(
  session: SkillSession, args: Record<string, unknown>, models: string[],
): Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }> {
  let lastErr: unknown = new Error('evaluateWithFailover: lista de modelos vacía');
  for (const model of models) {
    try {
      const res = await session.skill('decision-protocol', { args, result: LlmVerdictSchema, model });
      return { verdict: res.data, modelUsed: `${res.model.provider}/${res.model.id}`, tokens: extractTokens(res.usage) };
    } catch (err: unknown) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
```

- [ ] **Step 4: Correr y ver pasar; typecheck**

Run: `npx vitest run src/lib/reasoning/evaluate-with-failover.test.ts && npm run typecheck`
Expected: PASS, sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/evaluate-with-failover.ts src/lib/reasoning/evaluate-with-failover.test.ts
git commit -m "feat: evaluateWithFailover (llamada LLM + failover, sesión inyectable) (SP7 Task 3)"
```

---

## Task 4: `runDecisionMaker` (orquestación, best-effort + idempotente)

**Files:**
- Create: `src/lib/reasoning/run-decision-maker.ts`
- Test: `src/lib/reasoning/run-decision-maker.test.ts`

**Interfaces:**
- Consumes: `Signal`, `Strategy` (de `../scanner/types.ts`), `LlmVerdict`, `ShadowVerdictRow`.
- Produces:
  - `interface ShadowEvalArgs { symbol: string; snapshot: unknown; riskParams: Record<string, unknown>; timeframes: unknown }`
  - `interface DecisionMakerDeps { getSignal; getStrategy; evaluate; isAlreadyEvaluated; persist; audit }` (firmas abajo)
  - `type DecisionOutcome = { kind: 'persisted'; verdict: LlmVerdict } | { kind: 'not_found' } | { kind: 'duplicate' } | { kind: 'failed'; error: string }`
  - `runDecisionMaker(signalId: string, deps: DecisionMakerDeps): Promise<DecisionOutcome>` (nunca lanza)

- [ ] **Step 1: Escribir el test**

Crear `src/lib/reasoning/run-decision-maker.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { runDecisionMaker, type DecisionMakerDeps } from './run-decision-maker.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';

const SIGNAL: Signal = { strategyId: 's1', symbol: 'BTC/USDT', firedAt: new Date('2026-03-21T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
const STRATEGY: Strategy = { id: 's1', enabled: true, symbols: ['BTC/USDT'], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: { atr_stop_mult: 1.5 }, version: 1, skillName: null };
const VERDICT: LlmVerdict = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' };

function deps(over: Partial<DecisionMakerDeps> = {}): DecisionMakerDeps {
  return {
    getSignal: async () => SIGNAL,
    getStrategy: async () => STRATEGY,
    isAlreadyEvaluated: async () => false,
    evaluate: async () => ({ verdict: VERDICT, modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 99 }),
    persist: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    ...over,
  };
}

describe('runDecisionMaker', () => {
  test('camino feliz → persisted y persiste el row', async () => {
    const d = deps();
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ signalId: 'sig1', modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 99, confianza: 'media' }));
    expect(d.audit).not.toHaveBeenCalled(); // camino feliz no audita
  });

  test('señal inexistente → not_found, no evalúa', async () => {
    const d = deps({ getSignal: async () => null, evaluate: vi.fn() });
    const r = await runDecisionMaker('x', d);
    expect(r.kind).toBe('not_found');
    expect(d.evaluate).not.toHaveBeenCalled();
  });

  test('estrategia inexistente → not_found, no evalúa', async () => {
    const d = deps({ getStrategy: async () => null, evaluate: vi.fn() });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('not_found');
    expect(d.evaluate).not.toHaveBeenCalled();
  });

  test('ya evaluada → duplicate, no evalúa ni persiste', async () => {
    const d = deps({ isAlreadyEvaluated: async () => true, evaluate: vi.fn(), persist: vi.fn() });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('duplicate');
    expect(d.evaluate).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
  });

  test('fallo del modelo → failed + audita shadow_failed, NO lanza', async () => {
    const d = deps({ evaluate: async () => { throw new Error('modelo caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('failed');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'shadow_failed' }));
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/lib/reasoning/run-decision-maker.ts`:

```ts
import type { Signal, Strategy } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { ShadowVerdictRow } from '../../db/repositories/shadow-verdicts.ts';

export interface ShadowEvalArgs {
  symbol: string;
  snapshot: unknown;
  riskParams: Record<string, unknown>;
  timeframes: unknown;
}

export interface DecisionMakerDeps {
  getSignal: (signalId: string) => Promise<Signal | null>;
  getStrategy: (strategyId: string) => Promise<Strategy | null>;
  isAlreadyEvaluated: (signalId: string) => Promise<boolean>;
  evaluate: (args: ShadowEvalArgs) => Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }>;
  persist: (row: ShadowVerdictRow) => Promise<void>;
  audit: (entry: { eventType: string; actor: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

export type DecisionOutcome =
  | { kind: 'persisted'; verdict: LlmVerdict }
  | { kind: 'not_found' }
  | { kind: 'duplicate' }
  | { kind: 'failed'; error: string };

// Orquestación determinista del shadow eval: carga la señal/estrategia, llama al LLM (vía deps.evaluate
// con failover), persiste el veredicto. Best-effort: un fallo del modelo se audita y NUNCA se propaga.
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

  try {
    const { verdict, modelUsed, tokens } = await deps.evaluate(args);
    await deps.persist({
      signalId, verdict, confianza: verdict.confianza, razonamiento: verdict.razonamiento, modelUsed, tokens,
    });
    return { kind: 'persisted', verdict };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try { await deps.audit({ eventType: 'shadow_failed', actor: 'decision-maker', payload: { signalId, error } }); } catch { /* best-effort: ni el audit puede tumbar el shadow */ }
    return { kind: 'failed', error };
  }
}
```

- [ ] **Step 4: Correr y ver pasar; typecheck**

Run: `npx vitest run src/lib/reasoning/run-decision-maker.test.ts && npm run typecheck`
Expected: PASS, sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reasoning/run-decision-maker.ts src/lib/reasoning/run-decision-maker.test.ts
git commit -m "feat: runDecisionMaker (orquestación shadow, best-effort + idempotente) (SP7 Task 4)"
```

---

## Task 5: Workflow `decision-maker` (cablea harness → runDecisionMaker) + smoke vivo

Glue Flue: el `defineWorkflow` que une el harness real (sesión + modelos) con la lógica testeada. El workflow en sí no se unit-testea (su lógica vive en Tasks 3–4); se valida con typecheck + un smoke vivo contra el modelo real.

**Files:**
- Create: `src/workflows/decision-maker.ts`
- Modify: `src/lib/reasoning/run-decision-maker.ts` (nada — ya está; este task solo lo consume)

**Interfaces:**
- Consumes: `defineAgent`, `defineWorkflow`, `invoke` (de `@flue/runtime`); skill `decision-protocol`; `evaluateWithFailover`, `SkillSession`; `runDecisionMaker`, `ShadowEvalArgs`, `DecisionMakerDeps`; repos `getSignalById`, `getStrategy`, `insertShadowVerdict`, `isAlreadyEvaluated`; `appendAuditLog`; `LlmVerdictSchema`.
- Produces: workflow descubierto `decision-maker` con `input = { signalId }`.

- [ ] **Step 1: Implementar el workflow**

Crear `src/workflows/decision-maker.ts`:

```ts
import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import decisionProtocol from '../skills/decision-protocol/SKILL.md' with { type: 'skill' };
import { evaluateWithFailover, type SkillSession } from '../lib/reasoning/evaluate-with-failover.ts';
import { runDecisionMaker, type DecisionMakerDeps } from '../lib/reasoning/run-decision-maker.ts';
import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { insertShadowVerdict, isAlreadyEvaluated } from '../db/repositories/shadow-verdicts.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';
import { LlmVerdictSchema } from '../lib/reasoning/verdict-schema.ts';

// Modelos por env (§9): no hardcodear el id exacto de Opus. Si no hay escalación, el failover
// reintenta el mismo modelo (resiliencia ante error transitorio de proveedor).
const DECISION_MODEL = process.env.DECISION_MODEL ?? 'anthropic/claude-sonnet-4-6';
const ESCALATION = process.env.DECISION_MODEL_ESCALATION;
const MODELS = ESCALATION ? [DECISION_MODEL, ESCALATION] : [DECISION_MODEL, DECISION_MODEL];

const decisionAgent = defineAgent(() => ({
  model: DECISION_MODEL,
  thinkingLevel: 'high',
  skills: [decisionProtocol],
  // SIN tools de mutación: el decision-maker solo emite veredicto (línea roja).
}));

export default defineWorkflow({
  agent: decisionAgent,
  input: v.object({ signalId: v.string() }),
  output: v.object({ outcome: v.picklist(['persisted', 'not_found', 'duplicate', 'failed']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    const deps: DecisionMakerDeps = {
      getSignal: getSignalById,
      getStrategy,
      isAlreadyEvaluated,
      // ShadowEvalArgs satisface Record<string,unknown> en runtime; el cast resuelve la restricción nominal de TS.
      evaluate: (args) => evaluateWithFailover(session, args as unknown as Record<string, unknown>, MODELS),
      persist: insertShadowVerdict,
      audit: appendAuditLog,
    };
    const result = await runDecisionMaker(input.signalId, deps);
    return { outcome: result.kind };
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: sin errores. (Confirma que el import `with { type: 'skill' }` y la firma de `defineWorkflow`/`session.skill` compilan contra los tipos reales de Flue. Si `session` no encaja en `SkillSession`, ajustar el cast/adaptador — NO inventar; revisar `node_modules/@flue/runtime/docs/api/agent-api.md`.)

- [ ] **Step 3: Smoke vivo (modelo real)**

Prerrequisitos: `docker compose up -d`, `npm run migrate`, una señal real en `kairos.signals` (córrela vía `npm run worker` con backfill, o inserta una de prueba), y **`ANTHROPIC_API_KEY` en `.env`**.

> **Importante:** `SHADOW_WORKER` NO debe estar `on` en `.env` al correr `flue run` — `flue run` importa `app.ts`, y si el shadow worker arranca, mantiene el proceso Node vivo (conexión Redis) y `flue run` **nunca sale** (cuelga sin mensaje). Déjalo sin setear u `off` para este smoke.

Run: `npx flue run decision-maker --input '{"signalId":"<un signalId real>"}'`
Expected: el comando reporta eventos del run e imprime el resultado JSON `{ "outcome": "persisted" }` (o `not_found` si el id no existe). Verifica que se creó la fila:
`SELECT verdict, model_used, tokens FROM kairos.shadow_verdicts WHERE signal_id = '<signalId>';`
Debe tener un `LlmVerdict` válido y `model_used`/`tokens` poblados. **Este smoke es no determinista; no entra en la suite.**

> Si `flue run` falla por credencial o por el id exacto del modelo, ese es el de-risk de SP7: ajusta `ANTHROPIC_API_KEY` y, si configuraste `DECISION_MODEL_ESCALATION`, confirma el specifier de Opus contra el catálogo (`flue dev`). Reporta lo aprendido.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/decision-maker.ts
git commit -m "feat: workflow decision-maker (Flue session → runDecisionMaker) (SP7 Task 5)"
```

---

## Task 6: Cola `shadow-eval` + enqueue best-effort desde `evaluate-worker`

**Files:**
- Create: `src/lib/queue/shadow-queue.ts`
- Modify: `src/lib/queue/evaluate-worker.ts`
- Test: `src/lib/queue/shadow-queue.test.ts`

**Interfaces:**
- Consumes: `Queue`, `ConnectionOptions` (bullmq), `getBullConnection`.
- Produces:
  - `SHADOW_QUEUE = 'shadow-eval'`
  - `buildShadowJob(signalId: string): { name: string; data: { signalId: string }; opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean } }` (puro, `jobId = signalId`)
  - `enqueueShadowEval(signalId: string): Promise<void>`
  - `closeShadowQueue(): Promise<void>`

- [ ] **Step 1: Escribir el test (de la parte pura)**

Crear `src/lib/queue/shadow-queue.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildShadowJob } from './shadow-queue.ts';

describe('buildShadowJob', () => {
  test('jobId = signalId (dedup de encolado)', () => {
    const spec = buildShadowJob('sig-123');
    expect(spec.opts.jobId).toBe('sig-123');
    expect(spec.data.signalId).toBe('sig-123');
    expect(spec.name).toBe('shadow');
  });
  test('signalId vacío lanza', () => {
    expect(() => buildShadowJob('')).toThrow();
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run src/lib/queue/shadow-queue.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar la cola**

Crear `src/lib/queue/shadow-queue.ts` (mismo patrón que `evaluate-queue.ts`):

```ts
import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './connection.ts';

export const SHADOW_QUEUE = 'shadow-eval';

export interface ShadowJobData { signalId: string; }
export interface ShadowJobSpec {
  name: string;
  data: ShadowJobData;
  opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
}

// Puro y testeable: jobId = signalId → BullMQ ignora duplicados con el mismo id.
export function buildShadowJob(signalId: string): ShadowJobSpec {
  if (!signalId) throw new Error('signalId requerido para encolar shadow-eval');
  return { name: 'shadow', data: { signalId }, opts: { jobId: signalId, removeOnComplete: true, removeOnFail: false } };
}

let queue: Queue<ShadowJobData> | null = null;
function getQueue(): Queue<ShadowJobData> {
  if (!queue) {
    const conn = getBullConnection() as unknown as ConnectionOptions;
    queue = new Queue(SHADOW_QUEUE, { connection: conn });
  }
  return queue;
}

export async function enqueueShadowEval(signalId: string): Promise<void> {
  const spec = buildShadowJob(signalId);
  await getQueue().add(spec.name, spec.data, spec.opts);
}

export async function closeShadowQueue(): Promise<void> {
  if (queue) { await queue.close(); queue = null; }
}
```

- [ ] **Step 4: Encolar best-effort desde `evaluate-worker`**

En `src/lib/queue/evaluate-worker.ts`, importar y encolar el shadow tras `evaluateCandidate` (best-effort: un fallo de encolado NUNCA tumba el job del money path). Cambiar el handler del Worker:

```ts
import { enqueueShadowEval } from './shadow-queue.ts';
// …
  const w = new Worker<EvaluateJobData>(
    EVALUATE_QUEUE,
    async (job) => {
      await evaluateCandidate(job.data.signalId);
      // Shadow eval (Fase 2, SP7): best-effort, fuera del camino del dinero. Un fallo aquí se
      // audita y se traga; el job del money path ya completó su trabajo determinista.
      try {
        await enqueueShadowEval(job.data.signalId);
      } catch (err: unknown) {
        void appendAuditLog({ eventType: 'shadow_enqueue_failed', actor: 'evaluate-worker',
          payload: { signalId: job.data.signalId, error: err instanceof Error ? err.message : String(err) } }).catch(() => {});
      }
    },
    { connection: conn, concurrency: 1 },
  );
```

(`appendAuditLog` ya está importado en `evaluate-worker.ts`.)

- [ ] **Step 5: Correr la suite + typecheck**

Run: `npx vitest run src/lib/queue/shadow-queue.test.ts && npm run typecheck && npm test`
Expected: PASS; sin regresiones (el cambio en `evaluate-worker.ts` es aditivo y no se unit-testea — es glue de la capa BullMQ).

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue/shadow-queue.ts src/lib/queue/shadow-queue.test.ts src/lib/queue/evaluate-worker.ts
git commit -m "feat: cola shadow-eval + enqueue best-effort tras evaluateCandidate (SP7 Task 6)"
```

---

## Task 7: Worker `shadow-eval` dentro del runtime Flue (`app.ts`)

Glue de integración: un Worker BullMQ que corre en el proceso del servidor Flue (`app.ts`) y, por cada job, llama `invoke(decisionMaker, {signalId})` in-process. Validado por typecheck + smoke vivo end-to-end.

**Files:**
- Create: `src/shadow/shadow-worker.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `Worker`, `ConnectionOptions` (bullmq); `getBullConnection`; `invoke` (de `@flue/runtime`); workflow `decisionMaker` (default export de `../workflows/decision-maker.ts`); `SHADOW_QUEUE`, `ShadowJobData`; `appendAuditLog`.
- Produces: `startShadowWorker(): Worker<ShadowJobData> | null` (null si no debe arrancar).

- [ ] **Step 1: Implementar el shadow worker**

Crear `src/shadow/shadow-worker.ts`:

```ts
import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { invoke } from '@flue/runtime';
import { getBullConnection } from '../lib/queue/connection.ts';
import { SHADOW_QUEUE, type ShadowJobData } from '../lib/queue/shadow-queue.ts';
import decisionMaker from '../workflows/decision-maker.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Worker del runtime Flue: admite el run del decision-maker (fire-and-forget). invoke() solo
// funciona dentro del servidor Flue, por eso este worker vive en app.ts (no en worker.ts).
// Guardado: solo arranca cuando se configura explícitamente (no durante build/test).
export function startShadowWorker(): Worker<ShadowJobData> | null {
  if (process.env.SHADOW_WORKER !== 'on') return null;
  const conn = getBullConnection() as unknown as ConnectionOptions;
  const w = new Worker<ShadowJobData>(
    SHADOW_QUEUE,
    async (job) => { await invoke(decisionMaker, { input: { signalId: job.data.signalId } }); },
    { connection: conn, concurrency: 1 },
  );
  w.on('error', (err) => process.stderr.write(`[shadow-worker] error: ${err}\n`));
  w.on('failed', (job, err) => {
    void appendAuditLog({ eventType: 'shadow_admit_failed', actor: 'shadow-worker',
      payload: { signalId: job?.data?.signalId ?? null, error: err instanceof Error ? err.message : String(err) } }).catch(() => {});
  });
  return w;
}
```

- [ ] **Step 2: Arrancar el worker en `app.ts`**

En `src/app.ts`, arrancar el shadow worker al cargar el módulo del servidor (patrón del doc de schedules: side-effects de arranque en `app.ts`). El guard `SHADOW_WORKER=on` evita que arranque durante `flue build`/discovery o en tests:

```ts
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import health from './health.ts';
import { startShadowWorker } from './shadow/shadow-worker.ts';

// SP7: el worker de shadow-eval vive en el runtime Flue para poder llamar invoke() in-process.
startShadowWorker();

const app = new Hono();
app.route('/', health);
app.route('/', flue());

export default app;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: sin errores. (Confirma `invoke(decisionMaker, { input })` contra la firma real — ver `node_modules/@flue/runtime/docs/guide/workflows.md`: `invoke(workflow, { input })`.)

- [ ] **Step 4: Smoke vivo end-to-end**

Prerrequisitos: compose arriba, `npm run migrate`, `ANTHROPIC_API_KEY` y `REDIS_BULLMQ_URL` en `.env`, `SHADOW_WORKER=on`.

1. Arrancar el servidor Flue con el shadow worker: `SHADOW_WORKER=on npm run dev` (o `npm run build && SHADOW_WORKER=on npm start`).
2. En otra terminal, encolar un shadow job para una señal real existente — vía `npm run worker` (que ahora encola shadow tras cada evaluate) **o** insertando el job manualmente a la cola `shadow-eval` con `jobId=signalId`.
3. Verificar que apareció la fila:
   `SELECT outcome_check.* FROM (SELECT signal_id, model_used FROM kairos.shadow_verdicts) outcome_check WHERE signal_id = '<signalId>';`
   y/o `SELECT event_type FROM kairos.audit_log WHERE event_type IN ('shadow_failed','shadow_admit_failed') ORDER BY ts DESC LIMIT 5;` para descartar fallos.

Expected: un `shadow_verdicts` poblado para la señal, sin `shadow_failed`. Si falla, revisar logs del proceso Flue (el decision-maker corre ahí). **No determinista; no entra en la suite.**

- [ ] **Step 5: Commit**

```bash
git add src/shadow/shadow-worker.ts src/app.ts
git commit -m "feat: shadow worker en el runtime Flue (invoke decision-maker) (SP7 Task 7)"
```

---

## Cierre

Tras la Task 7, con la suite unit + typecheck en verde y los dos smokes vivos validados (Task 5: `flue run` produce un veredicto Valibot real; Task 7: el loop encola→admite→persiste un `shadow_verdicts`), usar **superpowers:finishing-a-development-branch**. Actualizar `CLAUDE.md` (Estado: SP7 hecho, primer LLM en sombra; el camino del dinero sigue determinista) y la memoria del proyecto como paso final, fuera del alcance de las tareas TDD.

**Nota de durabilidad (aceptada para SP7):** el shadow eval es best-effort. `invoke()` es fire-and-forget; si el proceso Flue muere a mitad del run del decision-maker, ese veredicto en sombra se pierde silenciosamente (el job BullMQ ya completó su admisión). Es tolerable porque la sombra es observacional y no toca dinero; una sombra durable (esperar el resultado del run, reintentar) es trabajo de SP10 si la medición A/B lo necesita.

**Shutdown del shadow worker (diferido):** el `startShadowWorker()` en `app.ts` no se cierra ordenadamente (el graceful shutdown de SP6 vive en `worker.ts`, otro proceso). Es inocuo en SP7 (al matar el proceso Flue, el OS cierra la conexión Redis), pero al endurecer el proceso Flue conviene cerrarlo con un handler propio en `app.ts`.
