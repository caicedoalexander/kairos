# SP9 — Analista fundamental condicional (CryptoPanic) + skill `fundamental-read` (Fase 2, sub-proyecto 3)

**Fecha:** 2026-06-28
**Estado:** diseño aprobado, listo para plan de implementación.

## Contexto: dónde encaja en Fase 2

Fase 1 (loop determinista en `sim`) está completa. **Fase 2 = Razonamiento (LLM)**, decompuesta en
SPs (ARCHITECTURE §13):

| SP | Alcance |
|---|---|
| SP7 *(hecho)* | Cimiento LLM en Flue + decision-maker en **sombra** (sin analistas). |
| SP8 *(hecho)* | Analista técnico (subagente `session.task`) + skill `technical-read`. |
| **SP9 (este)** | Analista fundamental **condicional** + skill `fundamental-read` + fuente CryptoPanic. |
| SP10 | Escalación (Sonnet→Opus) + `risk-policy` + **medición A/B** del edge LLM vs determinista. |
| SP11 *(separable)* | Canal de control WhatsApp inbound. |

SP9 añade el **segundo subagente** y la **primera fuente externa**. Sigue en **sombra** sobre `sim`:
el dinero no se toca.

## Meta

Que el decision-maker, además del `technical_read` (SP8), reciba un `fundamental_read` cuando hay
algo que leer: el código **busca noticias** (CryptoPanic), un **gate determinista** decide si vale la
pena, y solo entonces un **analista fundamental** (subagente Haiku, solo lectura) emite un
`fundamental_read` estructurado (catalizadores + decaimiento, §17.5) que **modula** el veredicto
(veto/cautela/refuerzo, §17.4). El fetch y el LLM son **best-effort**; el dinero (sim) sigue
ejecutando el determinista. El A/B se mide en SP10.

## Decisiones de diseño (aprobadas)

1. **Fuente: solo CryptoPanic** (noticias/catalizadores — el veto, la señal fundamental de mayor
   valor) en SP9. LunarCrush (sentimiento) y on-chain (Glassnode/Santiment) **diferidos**.
2. **Pre-fetch en código de orquestación:** el código determinista busca las noticias (controla
   rate-limits/timeouts/errores) y pasa los datos al analista en el prompt. El analista **solo
   razona** (consistente con SP8: "código mira, LLM juzga"). Sin tools de fetch en el subagente.
3. **Gate determinista:** major-cap (BTC/ETH) **Y** (catalizador en ventana **O** derivados
   extremos). La escalación §9 es de SP10.

## Hechos de la API de Flue (reutilizados de SP8, ya verificados)

> Verificados contra `node_modules/@flue/runtime/docs/` en SP8 — NO de memoria.

- Subagente = `defineAgentProfile({ name, description, model, thinkingLevel, skills, tools })` en
  `subagents:[]`. `skills`/`tools` propios del profile (omitir = ninguno); `model`/`thinkingLevel`
  heredan si se omiten → fijar Haiku/`medium` explícitos.
- `session.task(text, { agent, result, model })` → `{ data, usage, model }` con `data` validado.
- `harness.session(name?)` obtiene/crea una sesión nombrada (SP8 validó la delegación por sesión
  nombrada en runtime — el desconocido M1 quedó resuelto).

## Arquitectura e integración

### Flujo (paso condicional tras el técnico)

```
runDecisionMaker(signalId, deps):
  signal + strategy → args
    ├─ analyze técnico (SP8)                                        → technical_read | null
    ├─ FUNDAMENTAL (SP9, condicional, código dirige):
    │    1. if !deps.isMajorCap(symbol)  → read=null, status='skipped_not_major', fetch_ok=null (sin fetch)
    │    2. else { items, ok } = deps.fetchNews(symbol)  ← best-effort: fail → {[],false} + audit fundamental_fetch_failed
    │    3. if deps.shouldRunFundamental(items, snapshot):
    │         try analyzeFundamental({ symbol, news: items, derivatives }) → read; status='ran'; fetch_ok=ok
    │         catch → read=null; status='failed'; fetch_ok=ok; audit fundamental_read_failed
    │       else → read=null; status = ok ? 'skipped_quiet' : 'skipped_fetch_failed'; fetch_ok=ok
    ├─ evaluate({ ...args, technical_read, fundamental_read })       → veredicto (decision-protocol)
    └─ persist(read técnico + read fundamental + status + veredicto) → shadow_verdicts (un INSERT)
```

El camino del dinero (`evaluateCandidate`) queda **intacto y sin LLM**. El major-cap se chequea
**antes** del fetch — CryptoPanic solo se llama para BTC/ETH (donde noticias/on-chain son fiables,
§17.2). Todo el trabajo LLM/fetch vive en el proceso del servidor Flue.

### Componentes nuevos

1. **`src/lib/reasoning/fundamental-read-schema.ts`** — `FundamentalReadSchema` Valibot +
   `parseFundamentalRead`. Contrato centrado en catalizadores + decaimiento (ver abajo).
2. **`src/lib/sources/cryptopanic.ts`** — cliente HTTP best-effort de CryptoPanic (free tier).
   `fetchCryptoPanicNews(symbol, opts)` → `NewsItem[]` filtrados a la ventana. Lee
   `CRYPTOPANIC_API_KEY` de env (closure). Interfaz inyectable para test (`fetch`/cliente).
3. **`src/lib/reasoning/fundamental-gate.ts`** — dos funciones puras: `isMajorCap(symbol)` y
   `shouldRunFundamental(news, snapshot)`. Umbrales como constantes nombradas.
4. **`src/lib/reasoning/analyze-fundamental.ts`** — `analyzeFundamental(session, args) → { read,
   modelUsed, tokens }` vía `session.task({ agent: 'fundamental-analyst', result:
   FundamentalReadSchema })`. Reutiliza `extractTokens`. **L1:** la interfaz `TaskSession` de
   `analyze-technical.ts` está tipada a `{ data: TechnicalRead }`; aquí se **clona** con su propio
   tipo `{ data: FundamentalRead }` (o se generaliza a `TaskSession<T>` — decisión del plan). NO se
   reutiliza literal (daría mismatch de tipos).
5. **`src/skills/fundamental-read/SKILL.md`** — doctrina: separar **catalizador de ruido**,
   **decaimiento temporal** (§17.5), leer **posicionamiento** desde funding/OI (`crowded_long` =
   riesgo de squeeze), sesgo/veto/cautela (§17.4). El analista recibe `news` y `derivatives` en el
   prompt; emite `bias`/`catalysts`/`positioning`/`confidence` (y `decayNote` si hay catalizador).
   Guía razonamiento, no añade cómputo.

### Componentes modificados

6. **`src/lib/reasoning/run-decision-maker.ts`** — `DecisionMakerDeps` gana `isMajorCap`,
   `fetchNews`, `shouldRunFundamental`, `analyzeFundamental`. `ShadowEvalArgs` gana
   `fundamental_read?: FundamentalRead | null`. La orquestación corre el paso condicional con
   degradación, inyecta `fundamental_read` (snake_case) en los args de `evaluate`, y persiste
   read/model/tokens/status. La regla de SP7/SP8 se preserva: solo el fallo de `evaluate` →
   `shadow_failed`; `persist` propaga (infra).
7. **`src/skills/decision-protocol/SKILL.md`** — documenta `fundamental_read` y cómo pesarlo
   (veto en catalizador bajista relevante → `skip`/`confianza baja`; cautela en extremo → baja
   `sizingFactor`; refuerzo en alcista + acumulación; neutral → decide la técnica, §17.4). Mantiene
   la instrucción R1 (no delegar — los reads ya vienen en `args`).
8. **`src/workflows/decision-maker.ts`** — registra el profile `fundamentalAnalyst` (Haiku,
   `thinkingLevel: 'medium'`, `tools: []`, `skills: [fundamentalRead]`) en `subagents:[]`; cablea
   `isMajorCap`/`fetchNews`/`shouldRunFundamental`/`analyzeFundamental` (analyze sobre una sesión
   dedicada, p. ej. `harness.session('fundamental')`).
9. **`src/db/schema.sql`** — `shadow_verdicts` gana `fundamental_read jsonb`, `fundamental_model
   text`, `fundamental_tokens integer`, `fundamental_status text`, `fundamental_fetch_ok boolean`
   (CREATE + `ALTER ... ADD COLUMN IF NOT EXISTS`).
10. **`src/db/repositories/shadow-verdicts.ts`** — `ShadowVerdictRow` y el INSERT/SELECT se
    extienden con los **5** campos nuevos.
11. **`.env.example`** — `CRYPTOPANIC_API_KEY` ya existe; documentar la ventana/umbrales si se
    exponen por env (si no, constantes en código).

## Contrato `fundamental_read` (Valibot)

```ts
export const FundamentalReadSchema = v.object({
  bias:        v.picklist(['bullish', 'neutral', 'bearish']),   // sesgo macro del conjunto leído
  catalysts:   v.array(v.object({                               // [] si no hay catalizador relevante
    title:     v.pipe(v.string(), v.minLength(1)),
    sentiment: v.picklist(['bullish', 'neutral', 'bearish']),
    relevance: v.picklist(['high', 'medium', 'low']),
  })),
  positioning: v.picklist(['crowded_long', 'crowded_short', 'neutral']),  // §17.4: lectura de funding/OI
  decayNote:   v.optional(v.pipe(v.string(), v.minLength(1))),  // §17.5: frescura del catalizador; ausente si catalysts=[]
  confidence:  v.picklist(['alta', 'media', 'baja']),
});
export type FundamentalRead = v.InferOutput<typeof FundamentalReadSchema>;
```

**`positioning` (H1):** los derivados (`fundingZ`/`oiChangePct`) son input **vivo** (§15, ya en el
snapshot) y son una rama del gate — el analista puede dispararse **solo por derivados extremos**, sin
noticias. Por eso el read necesita un slot estructurado para el posicionamiento (§17.4: "posicionamiento
de riesgo → cautela → baja sizing"), no doblarlo en `bias`. `decayNote` es **opcional**: solo aplica
cuando hay catalizador (en el camino positioning-only, `catalysts=[]` y `decayNote` se omite).

Sentimiento social y on-chain quedan **fuera del schema** hasta que lleguen sus fuentes (LunarCrush /
Glassnode, §17.2) — YAGNI. `positioning` **no** se difiere porque su fuente ya está viva.

## Gate determinista (`fundamental-gate.ts`)

```ts
const MAJOR_CAPS = new Set(['BTC', 'ETH']);     // §17.2: solo major-caps
const FUNDING_Z_EXTREME = 2.0;                   // |z| de funding que activa cautela fundamental
const OI_CHANGE_EXTREME_PCT = 10;                // |%| de cambio de OI que activa cautela

// base de 'BTC/USDT' → 'BTC'
export function isMajorCap(symbol: string): boolean { /* MAJOR_CAPS.has(base(symbol)) */ }

// El cliente CryptoPanic ya filtra a la ventana (la constante de ventana vive SOLO en el cliente,
// M2), así que news.length>0 ⇒ catalizador en ventana. El gate no conoce la ventana.
export function shouldRunFundamental(news: NewsItem[], snapshot: IndicatorSnapshot): boolean {
  const hasCatalyst = news.length > 0;
  const d = snapshot.derivatives;
  const extreme =
    (d.fundingZ != null && Math.abs(d.fundingZ) >= FUNDING_Z_EXTREME) ||
    (d.oiChangePct != null && Math.abs(d.oiChangePct) >= OI_CHANGE_EXTREME_PCT);
  return hasCatalyst || extreme;
}
```

`isMajorCap` se evalúa **antes** del fetch (corta sin gastar la llamada a CryptoPanic en alts).
**M2:** `NEWS_WINDOW_HOURS` vive **solo** en el cliente CryptoPanic; el gate confía en que el cliente
ya filtró (evita el drift de tener la constante en dos sitios).

## Cliente CryptoPanic (`src/lib/sources/cryptopanic.ts`)

`fetchCryptoPanicNews(symbol, { now, fetchImpl? })` → `{ items: NewsItem[]; ok: boolean }` —
`items` (`{ title, publishedAt, kind, url }`) filtrados a `NEWS_WINDOW_HOURS` (constante **solo aquí**,
M2), y `ok` indica si el fetch tuvo éxito (para distinguir `[]`-vacío de `[]`-por-fallo, H2). Best-effort:

- Lee `CRYPTOPANIC_API_KEY` de env (closure). **Si falta la key → `{ items: [], ok: false }`**
  (degrada; la credencial jamás entra al input del modelo — línea roja).
- Endpoint público free tier (`/api/v1/posts/?auth_token=…&currencies=BTC&public=true`).
- HTTP error / timeout / parse error → `{ items: [], ok: false }` (el llamador audita
  `fundamental_fetch_failed`). Éxito con cero noticias → `{ items: [], ok: true }`. Mismo principio
  best-effort que `notifyBestEffort`.
- **Caché in-memory por `(base, ventana)` (M1):** TTL corto (≤ `NEWS_WINDOW_HOURS`, p. ej. 10 min)
  para que varios candidatos BTC/ETH en la misma ventana **no** re-fetcheen y quemen la cuota free de
  CryptoPanic. El caché guarda el resultado `{ items, ok }`; un fallo (`ok:false`) se cachea con TTL
  más corto para reintentar pronto.
- `fetchImpl` inyectable (default `globalThis.fetch`) para testear con JSON canónico sin red; `now`
  inyectable para el filtro de ventana y el TTL del caché (los tests no usan reloj real).

## Persistencia (`shadow_verdicts`, delta)

```sql
ALTER TABLE kairos.shadow_verdicts
  ADD COLUMN IF NOT EXISTS fundamental_read     jsonb,    -- FundamentalRead; null si no corrió
  ADD COLUMN IF NOT EXISTS fundamental_model    text,
  ADD COLUMN IF NOT EXISTS fundamental_tokens   integer,
  ADD COLUMN IF NOT EXISTS fundamental_status   text,     -- ver taxonomía abajo
  ADD COLUMN IF NOT EXISTS fundamental_fetch_ok boolean;  -- H2: salud del fetch (null = no se intentó)
```

**`fundamental_status` (taxonomía, H2)** — disposición del analista; el A/B (SP10) la usa para saber
*por qué* el read es null sin minar el `audit_log`:

| status | cuándo | `fetch_ok` |
|---|---|---|
| `skipped_not_major` | symbol no es BTC/ETH (sin fetch) | `null` |
| `skipped_quiet` | major-cap, **fetch ok**, sin catalizador ni derivados extremos | `true` |
| `skipped_fetch_failed` | major-cap, **fetch falló**, sin derivados extremos (no se sabe si había catalizador) | `false` |
| `ran` | el analista corrió | `true` (limpio) / `false` (degradado: corrió por derivados extremos con noticias caídas) |
| `failed` | el analista lanzó | refleja el fetch |

`fundamental_fetch_ok` (H2) es ortogonal: distingue `skipped_quiet` (genuinamente tranquilo) de
`skipped_fetch_failed`, y un `ran` limpio de un `ran` **degradado** (corrió solo por derivados con el
lado de noticias caído). Sin esto el A/B contaría fetch-fallidos como "nada que leer", contaminando el
denominador. Va en el **mismo INSERT** del veredicto. Como en SP8, se persiste en `shadow_verdicts`
(no en `decisions`, §730): en sombra el veredicto LLM y sus reads viven juntos para A/B; migran a
`decisions` cuando el LLM ejecute (SP10).

## Resiliencia y líneas rojas

- **El fundamental no toca dinero:** su profile lleva `tools: []` (ninguna tool de mutación ni de
  efecto). Solo razona sobre las noticias que recibe en el prompt.
- **Credenciales en env/closure:** `CRYPTOPANIC_API_KEY` se lee en el cliente, **nunca** entra al
  `input` del modelo (línea roja de credenciales). Key ausente → degrada a `[]`.
- **Best-effort en dos capas:** fetch falla → `[]` (+ audit `fundamental_fetch_failed`); analista
  falla → `fundamental_read=null` + audit `fundamental_read_failed`. El veredicto se emite igual.
  Nunca rompe el shadow ni el money path. `persist` propaga (infra), como SP7/SP8.
- **Invocación condicional** preserva la "forma del costo" (§17.3): Haiku solo corre cuando el gate
  pasa; en ventana tranquila no se gasta LLM.
- **Major-caps only** (§17.2). **Idempotencia** sin cambios (`jobId=signalId` + `UNIQUE(signal_id)`).
- **Modo**: respeta el `mode` activo; en SP9 corre en `sim`.

## Estrategia de testing

- **Cliente CryptoPanic (unit):** `fetchImpl` inyectable; parsea un JSON canónico, filtra por ventana
  (`now` inyectado), devuelve `{ items, ok }`; maneja key ausente → `{[],false}`, HTTP error →
  `{[],false}`, éxito-vacío → `{[],true}`. **Caché:** un segundo fetch dentro del TTL no llama a
  `fetchImpl` (se verifica con un spy). **Sin red.**
- **Gate (unit, puro):** `isMajorCap` (BTC/ETH sí, alt no) y `shouldRunFundamental` por tabla
  (catalizador/no × derivados extremos/no × combinaciones).
- **`analyzeFundamental` (unit):** sesión falsa que devuelve un `FundamentalRead` canónico (o lanza)
  — molde de SP8.
- **`runDecisionMaker` (unit):** deps inyectadas cubren todas las ramas y el `fundamental_status`/
  `fetch_ok` resultante: `skipped_not_major` (no fetch, no LLM, fetch_ok null), `skipped_quiet`
  (gate false, fetch ok), `skipped_fetch_failed` (gate false, fetch falló), `ran` limpio, `ran`
  degradado (fetch falló pero derivados extremos → corre con news=[]), analista-falla→`failed`
  (read null + audit + veredicto igual). Sin llamar al modelo ni a la red.
- **Schema (unit):** `parseFundamentalRead` con casos válidos/ inválidos (incl. `catalysts: []`).
- **Smoke vivo (separado):** `flue run decision-maker` con una señal BTC real → fetch real de
  CryptoPanic + Haiku fundamental + Sonnet integra. Valida el fetch externo end-to-end y la
  persistencia de `fundamental_*`.
- Cobertura ≥ 80%; `npm run typecheck` en verde.

## Criterios de éxito

- Un candidato **major-cap con catalizador o derivados extremos** produce un `shadow_verdicts` con
  `fundamental_read` (+ `fundamental_model`/`tokens`) y `fundamental_status='ran'`, sin tocar el
  camino del dinero.
- Un candidato **sin nada que leer** (alt, o ventana tranquila) deja `fundamental_read=null` con
  `fundamental_status` explicativo (`skipped_not_major`/`skipped_quiet`) y **no gasta Haiku**.
- Un fallo de fetch o del analista deja el read null + audit, y el veredicto **se emite igual**
  (degradación), sin romper ni retrasar nada.
- El subagente fundamental **no** tiene tools de mutación; la API key **no** entra al input del
  modelo (líneas rojas verificadas).
- Reintentar el job shadow no duplica la fila (idempotente por `signal_id`).
- `npm test` (deps inyectadas) y `npm run typecheck` en verde; cobertura ≥ 80%.
- Smoke vivo: `flue run decision-maker` produce un `fundamental_read` Valibot válido del modelo real
  a partir de noticias reales de CryptoPanic, y un veredicto que lo integra.

## Hallazgos de revisión de diseño (resueltos en este spec)

Revisado por `kairos-design-reviewer` contra la doc real de Flue, ARCHITECTURE.md (§9/§17/§730) y el
código de SP7/SP8. Veredicto: aprobado, sin CRITICAL; líneas rojas confirmadas. Resoluciones:

- **H1 — `positioning` en el schema:** el gate puede disparar solo por derivados extremos (sin
  noticias); §730/§17.4 listan `positioning` como modulador de primera clase y su fuente (§15) ya
  está viva → se añade `positioning` al `FundamentalReadSchema` y `decayNote` pasa a opcional (no
  aplica en el camino positioning-only). `sentiment`/`onchain` siguen diferidos (sus fuentes no).
- **H2 — taxonomía de `fundamental_status` + `fundamental_fetch_ok`:** el fetch-fallido se mislabel-aba
  como `skipped_quiet` (y un `ran` por derivados-extremos con noticias caídas era indistinguible de un
  `ran` limpio), contaminando el sustrato del A/B. Se añade el status `skipped_fetch_failed` y la
  columna ortogonal `fundamental_fetch_ok boolean`; el cliente devuelve `{ items, ok }`.
- **M1 — caché del fetch:** caché in-memory por `(base, ventana)` con TTL corto en el cliente
  CryptoPanic, para no re-fetchear ni quemar la cuota free con varios candidatos en la misma ventana.
- **M2 — ventana única:** `NEWS_WINDOW_HOURS` vive solo en el cliente; el gate confía en su filtrado
  (sin drift de constante duplicada).
- **L1 — `TaskSession` clonada:** `analyze-fundamental.ts` define su `TaskSession` tipada a
  `FundamentalRead` (o se generaliza a `TaskSession<T>`), no reutiliza la de `analyze-technical.ts`.
- **L2/L3 (informativos):** dos subagentes + dos sesiones nombradas no añaden riesgo (los subagentes
  se registran en el agente, no en la sesión — misma API validada en SP8/M1); `MAJOR_CAPS` es un Set
  nombrado, fácil de extender.

## Fuera de alcance de SP9 (van en SPs posteriores)

- **LunarCrush** (sentimiento social) y **on-chain** Glassnode/Santiment (§17.2, diferidos).
- Escalación determinista `shouldEscalate` (§9) y el **reporte A/B** (SP10).
- Sesión fresca por intento en el failover (SP10).
- Que el LLM **ejecute** el camino del dinero (decisión de SP10, con datos del A/B).
- Canal de control WhatsApp (SP11).
