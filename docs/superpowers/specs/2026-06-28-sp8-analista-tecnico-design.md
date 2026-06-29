# SP8 — Analista técnico (subagente) + skill `technical-read` (Fase 2, sub-proyecto 2)

**Fecha:** 2026-06-28
**Estado:** diseño aprobado, listo para plan de implementación.

## Contexto: dónde encaja en Fase 2

Fase 1 (loop determinista en `sim`) está completa. **Fase 2 = Razonamiento (LLM)**, decompuesta en
SPs (ARCHITECTURE §13):

| SP | Alcance |
|---|---|
| SP7 *(hecho)* | Cimiento LLM en Flue + decision-maker en **sombra** (sin analistas). |
| **SP8 (este)** | Analista técnico (subagente `session.task`) + skill `technical-read`. |
| SP9 | Analista fundamental (condicional) + `fundamental-read` + fuentes (CryptoPanic/LunarCrush). |
| SP10 | Escalación (Sonnet→Opus) + `risk-policy` + **medición A/B** del edge LLM vs determinista. |
| SP11 *(separable)* | Canal de control WhatsApp inbound. |

SP8 introduce el **primer subagente** del proyecto y enriquece el veredicto del decision-maker con
una lectura técnica cualitativa. Sigue en **sombra** sobre `sim`: el dinero no se toca.

## Meta

Que el decision-maker, antes de sintetizar su veredicto, **delegue** la interpretación del snapshot
ya computado a un **analista técnico** (subagente Haiku, solo lectura) que devuelve un
`technical_read` estructurado (Valibot). Ese read entra en los `args` del `decision-protocol` para
modular convicción/sizing, y se persiste junto al veredicto en `shadow_verdicts` para el A/B
posterior. El analista **nunca** recalcula indicadores ni toca dinero: *juzga, no calcula.*

## Hechos de la API de Flue verificados (1.0.0-beta.5)

> Verificados contra `node_modules/@flue/runtime/docs/` — NO de memoria (regla del proyecto).

- **Subagentes** (`docs/guide/subagents.md`): un subagente es un `defineAgentProfile({ name,
  description, instructions, skills, tools, model, thinkingLevel })` registrado en `subagents:[]`
  del agente. Corre en una **sesión hija aislada** (no hereda el transcript del padre). No es un
  endpoint direccionable; la delegación es in-process.
- **Herencia de configuración:** `instructions`/`tools`/`skills`/`subagents` son **propios del
  profile** (omitir = ninguno; nunca heredan del padre). `model`/`thinkingLevel`/`compaction`
  heredan como *default* si se omiten. `durability` está prohibido en un profile subagente.
- **Delegación desde workflow** (`docs/api/agent-api.md`): `session.task(text, { agent, result })`
  delega a un subagente nombrado y resuelve con `response.data` validado por el schema `result`.
  `TaskOptions` admite también `model`, `thinkingLevel`, `tools`, `signal`. El retorno es un
  `PromptResponse` (`{ data, usage, model }`) igual que `session.skill`.
- **Salida estructurada:** pasar el schema Valibot como `options.result` fuerza datos validados;
  lanza `ResultUnavailableError` si el modelo no produce datos válidos.

## Arquitectura e integración

### Flujo (paso previo determinista en el decision-maker)

El código dirige la delegación (no el modelo): el `run()` del workflow llama al analista de forma
explícita, así **siempre** se consulta al técnico y el camino es reproducible y testeable.

```
[proceso Flue, app.ts] Worker shadow-eval → invoke(decision-maker, {signalId})
  runDecisionMaker(signalId, deps):
    signal + strategy  →  args (symbol, snapshot, riskParams, timeframes)
      ├─ deps.analyze(args)  → technicalRead | null        ← NUEVO (session.task, Haiku)
      │     (si falla: technicalRead=null + audit technical_read_failed; NO rompe el shadow)
      ├─ deps.evaluate({ ...args, technicalRead })  → veredicto   (decision-protocol, Sonnet)
      └─ deps.persist({ verdict, technicalRead, ... })  → shadow_verdicts (un solo INSERT)
```

El camino del dinero (`evaluateCandidate`, plano, determinista) queda **intacto y sin LLM**. Todo el
trabajo LLM vive en el proceso del servidor Flue. SP8 no cambia la cola ni el worker shadow.

### Componentes nuevos

1. **`src/skills/technical-read/SKILL.md`** — doctrina cualitativa para el subagente técnico
   (§16.5): cómo leer **confluencia** (varias familias apuntando igual), **divergencia** (precio vs
   momentum), **régimen** (tendencia vs rango vía ADX/BB) y cómo pesar la **alineación MTF**
   (`aligned`/`mixed`/`counter`). Define el contrato de salida. Guía razonamiento, no añade cómputo.
   `name: technical-read` en el frontmatter = nombre del directorio.
2. **`src/lib/reasoning/technical-read-schema.ts`** — `TechnicalReadSchema` Valibot +
   `parseTechnicalRead`. Contrato cualitativo (ver abajo).
3. **`src/lib/reasoning/analyze-technical.ts`** — `analyzeTechnical(session, args) → { read,
   modelUsed, tokens }` que llama `session.task('<prompt>', { agent: 'technical-analyst', result:
   TechnicalReadSchema })`. Extrae `model`/`usage` igual que `evaluate-with-failover.ts`
   (reutiliza/clona `extractTokens`). **Sin failover propio en SP8** (degradación lo cubre; el
   failover fino del subagente es de SP10 si pesa). Define su propia interfaz mínima de sesión
   `TaskSession` con `.task(text, { agent, result, model })` (la actual `SkillSession` solo expone
   `.skill` — ver R4 abajo).

### Componentes modificados

4. **`src/workflows/decision-maker.ts`** — el `decisionAgent` registra `subagents:
   [technicalAnalyst]`, donde `technicalAnalyst = defineAgentProfile({ name: 'technical-analyst',
   description, instructions, skills: [technicalRead], model: TECHNICAL_MODEL, thinkingLevel:
   'medium', tools: [] })`. `TECHNICAL_MODEL = process.env.TECHNICAL_MODEL ??
   'anthropic/claude-haiku-4-5'`. El `run()` cablea `deps.analyze` sobre una **sesión dedicada**
   `harness.session('technical')` (R2) y `deps.evaluate` sobre la sesión del decision-maker, para no
   contaminar el transcript del padre con la ida/vuelta del analista.
5. **`src/lib/reasoning/run-decision-maker.ts`** — `DecisionMakerDeps` gana
   `analyze: (args: ShadowEvalArgs) => Promise<{ read: TechnicalRead; modelUsed: string; tokens:
   number | null }>`. La orquestación llama `analyze` con **degradación** (try/catch local: fallo →
   `technicalRead=null` + `deps.audit('technical_read_failed', { error, errorType })` (R1b),
   continúa). Pasa `technicalRead` (y `technicalModel`/`technicalTokens`) a `evaluate` (dentro de
   `args`) y a `persist`. **Si `evaluate` falla tras un `analyze` exitoso (R3):** el payload de
   `shadow_failed` incluye `technicalRead`/`technical_tokens`/`technical_model` para no perder el
   read ni el costo Haiku ya gastado.
6. **`src/skills/decision-protocol/SKILL.md`** — documenta que `args` ahora puede traer
   `technical_read` (de un analista técnico que ya leyó el snapshot) y cómo pesarlo: es **un insumo
   más**, no un oráculo; ante `technical_read` ausente (degradado) razona sobre el snapshot directo
   como hasta SP7. **Instrucción explícita (R1): el `technical_read` ya viene en `args`; NO delegues
   ni invoques ningún subagente — solo sintetiza el veredicto.**
7. **`src/db/schema.sql`** — `shadow_verdicts` gana `technical_read jsonb`, `technical_model text`,
   `technical_tokens integer` (todos nullable; `null` = analista degradado en ese eval).
8. **`src/db/repositories/shadow-verdicts.ts`** — `ShadowVerdictRow` y el INSERT se extienden con
   los tres campos nuevos. `getShadowVerdict` los devuelve.
9. **`src/lib/reasoning/run-decision-maker.ts`** (`ShadowEvalArgs`) — gana `technicalRead?:
   TechnicalRead | null` para que `evaluate` lo reciba dentro de `args`. **Mapeo de clave (R2b):**
   `evaluateWithFailover` pasa `args` tal cual a `session.skill`, así que el adaptador debe
   serializar `technicalRead` → `args.technical_read` (snake_case) antes de llamar al skill, o el
   `decision-protocol` no lo verá.
10. **`src/db/migrate.test.ts`** — sin cambios de tablas (sigue `shadow_verdicts`); si hay un test
    de columnas esperadas, se extiende con los tres campos nuevos.

## Contrato `technical_read` (Valibot)

```ts
export const TechnicalReadSchema = v.object({
  bias:       v.picklist(['bullish', 'neutral', 'bearish']),   // lectura direccional cualitativa
  confluence: v.picklist(['strong', 'moderate', 'weak']),      // cuántas familias apuntan igual
  regime:     v.picklist(['trending', 'ranging']),             // ADX/BB
  divergence: v.picklist(['none', 'bullish', 'bearish']),      // precio vs momentum
  mtfNote:    v.pipe(v.string(), v.minLength(1)),              // lectura de la alineación MTF
  notes:      v.pipe(v.string(), v.minLength(1)),              // 1-3 frases cualitativas auditables
});
export type TechnicalRead = v.InferOutput<typeof TechnicalReadSchema>;
```

Campos categóricos para que el A/B (SP10) los agregue; `mtfNote`/`notes` libres y auditables.

## Esquema `shadow_verdicts` (delta)

```sql
ALTER TABLE kairos.shadow_verdicts
  ADD COLUMN IF NOT EXISTS technical_read   jsonb,     -- TechnicalRead completo; null si degradado
  ADD COLUMN IF NOT EXISTS technical_model  text,      -- response.model.provider/id del analista
  ADD COLUMN IF NOT EXISTS technical_tokens integer;   -- response.usage del analista
```

El `schema.sql` es idempotente (`CREATE TABLE IF NOT EXISTS` + columnas con `IF NOT EXISTS`), así que
`npm run migrate` lo aplica sobre una tabla existente sin romper. El `technical_read` se persiste en
el **mismo INSERT** del veredicto (no hay segunda fila ni segunda capa de idempotencia).

## Persistencia: por qué `shadow_verdicts` y no `decisions`

ARCHITECTURE §253 reserva `decisions.technical_read jsonb`, pero `decisions` pertenece al **camino
determinista** (el veredicto que mueve dinero en sim). En **sombra**, el veredicto LLM —y por tanto
su `technical_read`— vive en `shadow_verdicts`, junto al determinista para el A/B. Es coherente con
la decisión de SP7. Cuando (SP10) el LLM pase a ejecutar el money path, el `technical_read` migrará
naturalmente a `decisions`.

## Resiliencia y líneas rojas

- **El analista no toca dinero** (línea roja): su profile lleva `tools: []` — ninguna tool de
  mutación, ni de lectura con efecto. Solo razona sobre el snapshot que recibe en el prompt. Se
  verifica igual que el decision-maker.
- **Degradación** (decisión de diseño): un fallo del `task` del analista deja `technicalRead=null`,
  se audita `technical_read_failed`, y el veredicto se emite igual sobre el snapshot directo (como
  SP7). El read es **enriquecimiento, no dependencia dura** → shadow robusto y best-effort (mismo
  principio que `notifyBestEffort`). El error de infraestructura (DB en `persist`) sigue propagando
  como en SP7 (run de Flue `failed`, no `shadow_failed`).
- **Idempotencia**: sin cambios — `jobId = signalId` + `UNIQUE(signal_id)` en `shadow_verdicts`.
- **Modo**: el shadow eval respeta el `mode` activo; en SP8 corre en `sim`.

## Estrategia de testing

- **Unit determinista (cobertura):** la suite inyecta una sesión falsa cuyo `analyze`/`evaluate`
  devuelven un `TechnicalRead`/`LlmVerdict` canónico (o lanzan, para probar degradación y
  best-effort). Cubre: orquestación de los dos pasos, degradación (analista lanza → `technicalRead`
  null + audit + veredicto emitido igual), persistencia con los tres campos nuevos, e idempotencia.
  Sin llamar al modelo. Schemas (`parseTechnicalRead`) con casos válidos/ inválidos.
- **Smoke vivo (separado, no determinista):** `flue run decision-maker --input '{"signalId":"..."}'`
  llama a Haiku (analista) + Sonnet (decision-maker) una vez; valida que el `technical_read` Valibot
  se cumple, que se persiste en `shadow_verdicts`, y que el veredicto final se emite. No entra en la
  cobertura unit.
- Cobertura ≥ 80%; `npm run typecheck` en verde.

## Criterios de éxito

- Una señal produce un `shadow_verdicts` con `verdict` **y** `technical_read` (más
  `technical_model`/`technical_tokens`), sin tocar el camino del dinero.
- Un fallo del analista técnico deja `technical_read` null + `technical_read_failed` auditado, y el
  veredicto LLM **se emite igual** (degradación), sin romper ni retrasar nada.
- El subagente técnico **no** tiene tools de mutación en su profile (línea roja verificada).
- Reintentar el job shadow no duplica la fila (idempotente por `signal_id`).
- `npm test` (sesión inyectada) y `npm run typecheck` en verde; cobertura ≥ 80%.
- Smoke vivo: `flue run decision-maker` produce un `technical_read` Valibot válido del modelo real y
  un veredicto que lo integra.

## Hallazgos de revisión de diseño (resueltos en este spec)

Revisado por `kairos-design-reviewer` contra la doc real de Flue (`subagents.md`, `agent-api.md`),
SP7 y ARCHITECTURE.md. Veredicto: aprobado, sin CRITICAL/HIGH. Resoluciones incorporadas:

- **R1 — auto-delegación del padre (M1):** registrar el subagente en `subagents:[]` lo expone al
  modelo padre (Sonnet), que *podría* invocar `task(technical-analyst)` por su cuenta durante el
  turno de `decision-protocol` (`subagents.md:33,37`), duplicando el costo Haiku y erosionando "el
  código dirige la delegación". Mitigación: el `decision-protocol/SKILL.md` instruye explícitamente
  no delegar (el read ya viene en `args`). El subagente sigue registrado porque `session.task`
  con nombre lo exige.
- **R1b — tipo de error en el audit (L1):** el payload de `technical_read_failed` captura `error` y
  `errorType` para que el A/B distinga "el modelo no produjo read" (`ResultUnavailableError`) de
  "infra/proveedor caído".
- **R2 — sesión dedicada para el analista (M2):** `analyze` corre sobre `harness.session('technical')`,
  no sobre la sesión del decision-maker, para mantener el transcript del padre limpio y determinista.
  El read limpio viaja al `decision-protocol` por `args.technical_read`, no por transcript.
- **R2b — mapeo snake_case (L2):** el adaptador serializa `technicalRead` → `args.technical_read`
  antes de `session.skill`, porque `evaluateWithFailover` pasa `args` sin transformar.
- **R3 — read perdido en `shadow_failed` (M3):** si `analyze` tuvo éxito pero `evaluate` falla, el
  payload de `shadow_failed` incluye `technicalRead`/`technical_tokens`/`technical_model`, para no
  perder el read computado ni el costo Haiku ya gastado.
- **R4 — interfaz de sesión con `.task` (L4):** la actual `SkillSession` (`evaluate-with-failover.ts`)
  solo expone `.skill`; `analyze-technical.ts` define su propia `TaskSession` con `.task(text,
  { agent, result, model })`. El cast en `decision-maker.ts` se ajusta para exponer ambas
  capacidades.
- **R5 — persistencia en `shadow_verdicts` vs ARCHITECTURE §253 (L3):** desviación justificada y
  coherente con SP7 (en sombra el veredicto LLM y su read viven en `shadow_verdicts` para A/B;
  migran a `decisions` cuando el LLM ejecute en SP10).

## Fuera de alcance de SP8 (van en SPs posteriores)

- Analista **fundamental** y sus fuentes/condicionalidad (SP9).
- Escalación determinista `shouldEscalate` (Sonnet→Opus) y el **reporte A/B** (SP10).
- **Sesión fresca por intento** en el failover del decision-maker/analista (SP10).
- Que el LLM **ejecute** el camino del dinero (decisión de SP10, con datos del A/B).
- Canal de control WhatsApp (SP11).
