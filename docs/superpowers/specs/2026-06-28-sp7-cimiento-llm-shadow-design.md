# SP7 — Cimiento LLM + decision-maker en sombra (Fase 2, sub-proyecto 1)

**Fecha:** 2026-06-28
**Estado:** diseño aprobado, listo para plan de implementación.

## Contexto: dónde encaja en Fase 2

Fase 1 (loop determinista en `sim`) está completa. **Fase 2 = Razonamiento (LLM)**, decompuesta en
SPs (ARCHITECTURE §13):

| SP | Alcance |
|---|---|
| **SP7 (este)** | Cimiento LLM en Flue + decision-maker en **sombra** (sin analistas). |
| SP8 | Analista técnico (subagente `session.task`) + skill `technical-read`. |
| SP9 | Analista fundamental (condicional) + `fundamental-read` + fuentes (CryptoPanic/LunarCrush). |
| SP10 | Escalación (Sonnet→Opus) + `risk-policy` + **medición A/B** del edge LLM vs determinista. |
| SP11 *(separable)* | Canal de control WhatsApp inbound. |

SP7 es el **de-risk del mayor desconocido**: el proyecto nunca ha corrido una sesión LLM. Lo prueba
end-to-end con la mínima superficie y **cero riesgo** sobre el camino del dinero.

## Meta

Que un candidato sea evaluado por un decision-maker LLM que emite un **veredicto estructurado**
(Valibot) vía Flue, en **modo sombra**: el veredicto LLM se persiste junto al determinista para A/B,
pero el dinero (`sim`) sigue ejecutando sobre el veredicto **determinista**. El switch a "el LLM
ejecuta" se decide después (SP10), con datos.

## Hechos de la API de Flue verificados (1.0.0-beta.5)

> Verificados contra `node_modules/@flue/runtime/docs/` — NO de memoria (regla del proyecto).

- **Salida estructurada:** `session.skill(skill, { args, result })` con `result` = schema Valibot →
  resuelve con `response.data` validado. Lanza `ResultUnavailableError` si el modelo no produce datos
  válidos. `response.usage` (tokens/costo) y `response.model` (`{provider, id}`).
- **Las sesiones requieren un harness** de un runner: `defineWorkflow({ agent, input, output, run({harness}) })`
  o `defineAgent`. **No hay sesión desde código suelto** → el veredicto LLM vive en un workflow Flue.
- **`invoke(workflow, {input})`** se llama desde código dentro del servidor Flue (`app.ts` y lo que
  arranca); resuelve al admitir el run (devuelve `runId`), no espera. Para sombra, fire-and-forget basta.
- **Failover** = reintentar la operación con `options.model` override (Sonnet→Opus).
- **Skills:** `import x from './skills/.../SKILL.md' with { type: 'skill' }` → registrar en `skills:[]`
  del agente; invocar por referencia/nombre con `session.skill`.

## Arquitectura e integración

### Componentes nuevos

1. **`src/skills/decision-protocol/SKILL.md`** — doctrina de cómo sintetizar la evidencia (en SP7,
   solo el snapshot de indicadores ya calculado) + el contrato de salida. Guía el razonamiento, no
   añade cómputo.
2. **`src/workflows/decision-maker.ts`** — `defineWorkflow`. El `agent` registra `decision-protocol`
   en `skills:[]`. `input = v.object({ signalId: v.string() })`. `run({harness, input})`:
   carga signal+strategy+snapshot (repos existentes) → `harness.session()` →
   `session.skill('decision-protocol', { args, result: LlmVerdictSchema })` con failover → persiste
   el veredicto LLM en `shadow_verdicts`. **Sin analistas** (SP8/SP9).
3. **Cola `shadow-eval` (BullMQ)** — `jobId = signalId`. La encola `evaluateCandidate` (best-effort)
   tras persistir la decisión determinista.
4. **Worker de `shadow-eval` dentro del runtime Flue** — `app.ts` arranca un `Worker` BullMQ para esa
   cola (igual que el doc de schedules arranca un Cron en `app.ts`). Su handler llama
   `invoke(decisionMaker, { input: { signalId } })` **in-process** (ahí `invoke()` funciona).
5. **`kairos.shadow_verdicts`** (tabla nueva, append-first) + su repo.

### Por qué este puente (worker↔Flue)

El camino del dinero (`worker.ts`, plano, determinista) queda **libre de Flue/LLM**: solo encola un
job. Todo el trabajo LLM vive en el proceso del servidor Flue (`app.ts`), conectado por Redis. En
Fase 2 hay dos procesos long-lived (ya hay precedente: `npm run worker` + `npm start`), ambos sobre
el mismo Postgres+Redis.

**Alternativa descartada:** que `worker.ts` invoque el workflow por HTTP — acopla HTTP innecesario
teniendo la espina BullMQ ya montada.

## Contrato del veredicto (Valibot)

Alineado con el `Verdict` determinista (`src/lib/execution/types.ts`) para que el A/B sea directo,
más los extras del LLM:

```ts
export const LlmVerdictSchema = v.object({
  action: v.picklist(['enter', 'skip']),
  entry: v.number(),
  sl: v.number(),
  tp: v.number(),
  sizingFactor: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  confianza: v.picklist(['alta', 'media', 'baja']),  // extra LLM
  razonamiento: v.string(),                            // extra LLM (auditable)
});
export type LlmVerdict = v.InferOutput<typeof LlmVerdictSchema>;
```

## Esquema `shadow_verdicts`

```sql
CREATE TABLE IF NOT EXISTS kairos.shadow_verdicts (
  id          text PRIMARY KEY,
  signal_id   text NOT NULL REFERENCES kairos.signals(id),
  verdict     jsonb NOT NULL,          -- LlmVerdict completo
  confianza   text NOT NULL,
  razonamiento text,
  model_used  text,                    -- response.model.provider/id
  tokens      integer,                 -- response.usage
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id)                   -- idempotencia: un shadow verdict por señal
);
```

`UNIQUE(signal_id)` + `jobId = signalId` deduplica el shadow eval al reintentar (dos capas, como el
camino del dinero).

## Flujo de datos

```
scan-tick → señal → evaluateCandidate (worker.ts, DETERMINISTA, sin cambios)
                       ├─ buildDeterministicVerdict → check_risk → execute_order (sim) → notify
                       └─ enqueue shadow-eval (best-effort, jobId=signalId)

[proceso Flue, app.ts] Worker shadow-eval → invoke(decision-maker, {signalId})
   decision-maker.run(): signal+snapshot → session.skill(decision-protocol, {result}) [failover]
                        → INSERT shadow_verdicts (verdict, confianza, model_used, tokens)
```

El A/B (comparar `shadow_verdicts` vs `decisions` por señal) es el substrato; el **reporte** es SP10.

## Resiliencia y líneas rojas

- **El LLM nunca toca dinero**: es sombra; `execute_order`/mutaciones jamás en `tools:[]` del agente.
- **Failover Sonnet→Opus**: envolver `session.skill(...)`; ante error de proveedor o
  `ResultUnavailableError`, reintentar con `{ model: '<opus>' }` (idealmente en sesión fresca para no
  arrastrar el turno fallido). Si ambos fallan → `shadow_failed`.
- **Best-effort**: un fallo del shadow eval se audita (`shadow_failed`) y se traga — **nunca** afecta
  el camino del dinero (mismo principio que `notifyBestEffort`).
- **Idempotencia**: `jobId = signalId` + `UNIQUE(signal_id)`.
- **Modo**: el shadow eval respeta el `mode` activo; en SP7 corre en `sim`.

## Estrategia de testing (lo nuevo: salida no determinista)

- **Unit determinista (cuenta para cobertura):** la lógica de `run()` se extrae a una función pura
  `runDecisionMaker(deps, input)` donde `deps` incluye una **sesión inyectable**. En tests, `deps`
  provee una sesión falsa que devuelve un `LlmVerdict` canónico (o lanza, para probar failover/best-effort)
  → se testea orquestación + persistencia + failover + idempotencia **sin llamar al modelo**. El
  `defineWorkflow.run` real delega en `runDecisionMaker` pasando una sesión adaptada del `harness`.
- **Smoke vivo (separado, no determinista):** `flue run decision-maker --input '{"signalId":"..."}'`
  llama al modelo real una vez y valida que el `result` Valibot se cumple. No entra en la cobertura unit.

## Criterios de éxito

- Una señal produce un `shadow_verdicts` con un `LlmVerdict` validado, `model_used` y `tokens`, sin
  tocar el camino del dinero (la posición determinista se abre igual que hoy).
- Un fallo del modelo/proveedor deja `shadow_failed` auditado y **no** rompe ni retrasa la ejecución
  determinista.
- Reintentar el job shadow no duplica el `shadow_verdicts` (idempotente por `signal_id`).
- `npm test` (unit con sesión inyectada) y `npm run typecheck` en verde; cobertura ≥ 80%.
- Smoke vivo: `flue run decision-maker` produce un veredicto Valibot válido del modelo real.

## Fuera de alcance de SP7 (van en SPs posteriores)

- Analistas técnico/fundamental y sus skills (SP8/SP9).
- Invocación condicional del fundamental, fuentes externas (SP9).
- Escalación determinista `shouldEscalate` y el reporte A/B (SP10).
- Que el LLM **ejecute** el camino del dinero (decisión de SP10, con datos del A/B).
- Canal de control WhatsApp (SP11).
