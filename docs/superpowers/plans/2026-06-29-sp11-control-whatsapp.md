# SP11 — Canal de control WhatsApp inbound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El número de control puede operar el bot por WhatsApp: `/estado` (read-only), `/pausa`/`/reanuda` (kill-switch), y texto libre interpretado por un LLM Haiku → comando seguro. Cierra Fase 2.

**Architecture:** El webhook Evolution existente (firma → autoriza → audita) gana: guardia `fromMe`, ack-then-process desacoplado, parsing slash determinista (sin LLM) y, para texto libre, `invoke(control-maker)` (LLM → `ControlIntent` → dispatch). El kill-switch (`bot_state.paused`) se aplica en DOS puntos: scan-tick (evita encolar) y `evaluateCandidate` (hard stop de jobs encolados, §53). El agente de control lleva `tools:[]`: clasifica intención, el código ejecuta.

**Tech Stack:** TypeScript (Node target de Flue), Flue 1.0.0-beta.5 (`invoke()` desde channel route, `session.skill`, `defineWorkflow`/`defineAgent`), Valibot, Postgres (esquema `kairos`), Vitest, Evolution REST (WhatsApp).

**Spec:** `docs/superpowers/specs/2026-06-29-sp11-control-whatsapp-design.md` (hallazgos H1/H2/M1-M3/L1-L3 incorporados).

## Global Constraints

- **Líneas rojas:** el agente `control-maker` lleva `tools: []` — solo emite `ControlIntent` (picklist cerrado); los handlers (`dispatchControl`) son deterministas. SP11 solo incluye comandos seguros (read + kill-switch). **No toca dinero** (`/cierra`/`/modo` diferidos a testnet).
- **H1 — kill-switch en DOS puntos:** scan-tick (evita encolar) **y** `evaluateCandidate` (deny/return antes de ejecutar, cierra la ventana de jobs encolados; §53).
- **H2 — guardia `fromMe`:** descartar (200) payloads con `key.fromMe === true` **antes** de autorizar (evita el lazo con la propia respuesta saliente).
- **M2 — ack-then-process:** el webhook responde 200 rápido y procesa desacoplado (`void processControlMessage(...).catch(...)`), best-effort.
- **Autorización antes del LLM:** `isAuthorizedSender` (solo `WHATSAPP_CONTROL_NUMBER`) ya filtra; no-autorizados nunca alcanzan el LLM/handlers.
- **`invoke()` desde channel route es válido** (confirmado en design-review contra workflows.md). Fire-and-forget.
- **Verifica la API de Flue contra su doc real.** Flue descubre TODO `.ts` plano en `src/workflows|channels|agents/` → no `.test.ts` ni no-workflows ahí; el skill nuevo va en `src/skills/control-protocol/`.
- **Estilo:** funciones <50 líneas, archivos <800, inmutabilidad, validación en límites, sin secretos, sin `console.log` de debug. Español.
- **Cobertura ≥ 80%**; `npm run typecheck` en verde (salvo estados intermedios documentados).

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `src/lib/control/control-intent-schema.ts` (+test) | `ControlIntentSchema` Valibot | Crear |
| `src/lib/control/parse-control.ts` (+test) | `parseSlashCommand` determinista | Crear |
| `src/db/schema.sql` + `src/db/repositories/bot-state.ts` (+test) | tabla `bot_state` + `getPaused`/`setPaused` | Crear/Mod |
| `src/lib/control/dispatch-control.ts` (+test) | `dispatchControl(intent, deps) → reply` | Crear |
| `src/lib/scanner/scan-tick.ts` (+test) | `isPaused` dep + skip si pausado | Modificar |
| `src/orchestration/evaluate-candidate.ts` (+test) | `isPaused` dep + hard stop (H1) | Modificar |
| `src/skills/control-protocol/SKILL.md` | doctrina texto→comando | Crear |
| `src/workflows/control-maker.ts` | workflow control (Haiku low, tools:[]) | Crear |
| `src/channels/evolution.ts` (+test) | `isFromMe`/`extractMessageText`/`processControlMessage` + wiring | Modificar |
| `ARCHITECTURE.md` §11/§65/§393-396 | desviación agente→workflow (M1) | Modificar |

---

### Task 1: Contrato `ControlIntentSchema`

**Files:**
- Create: `src/lib/control/control-intent-schema.ts`
- Test: `src/lib/control/control-intent-schema.test.ts`

**Interfaces:**
- Produces: `ControlIntentSchema` (Valibot), `type ControlIntent = { command: 'estado'|'pausa'|'reanuda'|'unknown' }`, `parseControlIntent(raw): ControlIntent`. Tareas 2, 4, 6 consumen.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/control/control-intent-schema.test.ts
import { describe, test, expect } from 'vitest';
import { parseControlIntent } from './control-intent-schema.ts';

describe('ControlIntentSchema', () => {
  test('acepta cada comando del picklist', () => {
    for (const command of ['estado', 'pausa', 'reanuda', 'unknown'] as const) {
      expect(parseControlIntent({ command })).toEqual({ command });
    }
  });
  test('rechaza un comando fuera del picklist', () => {
    expect(() => parseControlIntent({ command: 'cierra' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/control/control-intent-schema.test.ts`
Expected: FAIL — `Cannot find module './control-intent-schema.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/control/control-intent-schema.ts
import * as v from 'valibot';

// Intención de control parseada de un mensaje de WhatsApp. Picklist CERRADO: el LLM solo clasifica
// a uno de estos comandos seguros (el código ejecuta). 'unknown' = no soportado / no claro.
export const ControlIntentSchema = v.object({
  command: v.picklist(['estado', 'pausa', 'reanuda', 'unknown']),
});

export type ControlIntent = v.InferOutput<typeof ControlIntentSchema>;

export function parseControlIntent(raw: unknown): ControlIntent {
  return v.parse(ControlIntentSchema, raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/control/control-intent-schema.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/lib/control/control-intent-schema.ts src/lib/control/control-intent-schema.test.ts
git commit -m "feat: ControlIntentSchema (contrato Valibot del control, SP11)"
```

---

### Task 2: `parseSlashCommand` (parser determinista)

**Files:**
- Create: `src/lib/control/parse-control.ts`
- Test: `src/lib/control/parse-control.test.ts`

**Interfaces:**
- Consumes: `ControlIntent` (Task 1).
- Produces: `parseSlashCommand(text: string): ControlIntent | null` (null = texto libre que necesita el LLM). Tarea 7 consume.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/control/parse-control.test.ts
import { describe, test, expect } from 'vitest';
import { parseSlashCommand } from './parse-control.ts';

describe('parseSlashCommand', () => {
  test('mapea los comandos slash conocidos', () => {
    expect(parseSlashCommand('/estado')).toEqual({ command: 'estado' });
    expect(parseSlashCommand('/pausa')).toEqual({ command: 'pausa' });
    expect(parseSlashCommand('/reanuda')).toEqual({ command: 'reanuda' });
  });
  test('normaliza mayúsculas, espacios y el slash opcional', () => {
    expect(parseSlashCommand('  /ESTADO ')).toEqual({ command: 'estado' });
    expect(parseSlashCommand('Pausa')).toEqual({ command: 'pausa' });
  });
  test('texto libre → null (lo resuelve el LLM)', () => {
    expect(parseSlashCommand('¿cómo va el bot?')).toBeNull();
    expect(parseSlashCommand('/cierra BTC')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/control/parse-control.test.ts`
Expected: FAIL — `Cannot find module './parse-control.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/control/parse-control.ts
import type { ControlIntent } from './control-intent-schema.ts';

const SLASH: Record<string, ControlIntent['command']> = {
  estado: 'estado', pausa: 'pausa', reanuda: 'reanuda',
};

// Parser determinista de comandos slash conocidos. Devuelve null para todo lo demás (texto libre que
// el LLM debe interpretar). Acepta con/sin '/', mayúsculas y espacios; solo la primera palabra.
export function parseSlashCommand(text: string): ControlIntent | null {
  const first = text.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const word = first.startsWith('/') ? first.slice(1) : first;
  const command = SLASH[word];
  return command ? { command } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/control/parse-control.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/control/parse-control.ts src/lib/control/parse-control.test.ts
git commit -m "feat: parseSlashCommand (parser determinista de comandos, SP11)"
```

---

### Task 3: Tabla `bot_state` + repo (kill-switch)

**Files:**
- Modify: `src/db/schema.sql`
- Create: `src/db/repositories/bot-state.ts`
- Test: `src/db/repositories/bot-state.test.ts` (integración)

**Interfaces:**
- Produces: `getPaused(exec?): Promise<boolean>`; `setPaused(paused: boolean, exec?): Promise<void>` (upsert del singleton). Tareas 5, 4 consumen.

> `migrate.test.ts` valida nombres de tabla — **gana `bot_state`** en `EXPECTED_TABLES` (si no, ese test falla). Inclúyelo.

- [ ] **Step 1: Write the failing test**

```ts
// src/db/repositories/bot-state.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { getPaused, setPaused } from './bot-state.ts';

beforeAll(async () => { await migrate(); });
afterEach(async () => { await setPaused(false); });
afterAll(async () => { await pool.end(); });

describe('bot_state', () => {
  test('default no pausado; setPaused(true) → getPaused()===true; idempotente', async () => {
    expect(await getPaused()).toBe(false);
    await setPaused(true);
    expect(await getPaused()).toBe(true);
    await setPaused(true); // idempotente
    expect(await getPaused()).toBe(true);
    await setPaused(false);
    expect(await getPaused()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/bot-state.test.ts`
Expected: FAIL — `Cannot find module './bot-state.ts'` / tabla inexistente.

- [ ] **Step 3: Modify `schema.sql`**

Añade (junto a las otras tablas de dominio):

```sql
-- SP11: estado del bot (kill-switch). Single-row.
CREATE TABLE IF NOT EXISTS kairos.bot_state (
  id         text PRIMARY KEY DEFAULT 'singleton',
  paused     boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO kairos.bot_state (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 4: Write the repo**

```ts
// src/db/repositories/bot-state.ts
import { query, type Executor } from '../pool.ts';

const SINGLETON = 'singleton';

// Lee el flag de pausa global (default false si la fila no existe).
export async function getPaused(exec: Executor = query): Promise<boolean> {
  const rows = await exec<{ paused: boolean }>(`SELECT paused FROM kairos.bot_state WHERE id = $1`, [SINGLETON]);
  return rows[0]?.paused ?? false;
}

// Upsert del singleton: pausa/reanuda el bot. Idempotente.
export async function setPaused(paused: boolean, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.bot_state (id, paused, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = now()`,
    [SINGLETON, paused],
  );
}
```

- [ ] **Step 5: Update `migrate.test.ts`**

Añade `'bot_state'` a `EXPECTED_TABLES` en `src/db/migrate.test.ts`. **(M-3)** Actualiza también la
descripción del test que dice "crea las 16 tablas del esquema kairos" → "crea las **17** tablas del
esquema kairos".

- [ ] **Step 6: Run migrate + tests**

Run: `npm run migrate && npx vitest run src/db/repositories/bot-state.test.ts src/db/migrate.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/repositories/bot-state.ts src/db/repositories/bot-state.test.ts src/db/migrate.test.ts
git commit -m "feat: bot_state + getPaused/setPaused (kill-switch, SP11)"
```

---

### Task 4: `dispatchControl` (handlers deterministas)

**Files:**
- Create: `src/lib/control/dispatch-control.ts`
- Test: `src/lib/control/dispatch-control.test.ts`

**Interfaces:**
- Consumes: `ControlIntent` (Task 1); `OpenPosition` de `../../db/repositories/positions.ts`.
- Produces: `interface DispatchDeps { getOpenPositions: () => Promise<OpenPosition[]>; setPaused: (paused: boolean) => Promise<void> }`; `dispatchControl(intent: ControlIntent, deps: DispatchDeps): Promise<string>` (devuelve el texto de respuesta). Tareas 6, 7 consumen.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/control/dispatch-control.test.ts
import { describe, test, expect, vi } from 'vitest';
import { dispatchControl } from './dispatch-control.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';

const POS = { id: 'p1', strategyId: 's1', symbol: 'BTC/USDT', side: 'long', entry: 65000, size: 0.01,
  sl: 63000, tp: 68000, mode: 'sim', openedAt: new Date('2026-06-29T00:00:00Z'), triggerTimeframe: '15m', decisionId: 'd1', entryFee: 0 } as unknown as OpenPosition;

function deps(over: Record<string, unknown> = {}) {
  return { getOpenPositions: async () => [POS], setPaused: vi.fn(async () => {}), ...over } as Parameters<typeof dispatchControl>[1];
}

describe('dispatchControl', () => {
  test('estado: lista posiciones abiertas (read-only)', async () => {
    const reply = await dispatchControl({ command: 'estado' }, deps());
    expect(reply).toContain('BTC/USDT');
    expect(reply).toContain('1'); // nº de posiciones
  });
  test('estado sin posiciones', async () => {
    const reply = await dispatchControl({ command: 'estado' }, deps({ getOpenPositions: async () => [] }));
    expect(reply.toLowerCase()).toContain('sin posiciones');
  });
  test('pausa: setPaused(true) + confirma', async () => {
    const d = deps();
    const reply = await dispatchControl({ command: 'pausa' }, d);
    expect(d.setPaused).toHaveBeenCalledWith(true);
    expect(reply.toLowerCase()).toContain('pausado');
  });
  test('reanuda: setPaused(false) + confirma', async () => {
    const d = deps();
    const reply = await dispatchControl({ command: 'reanuda' }, d);
    expect(d.setPaused).toHaveBeenCalledWith(false);
    expect(reply.toLowerCase()).toContain('reanudado');
  });
  test('unknown: texto de ayuda con los comandos', async () => {
    const reply = await dispatchControl({ command: 'unknown' }, deps());
    expect(reply.toLowerCase()).toContain('/estado');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/control/dispatch-control.test.ts`
Expected: FAIL — `Cannot find module './dispatch-control.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/control/dispatch-control.ts
import type { ControlIntent } from './control-intent-schema.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';

export interface DispatchDeps {
  getOpenPositions: () => Promise<OpenPosition[]>;
  setPaused: (paused: boolean) => Promise<void>;
}

const AYUDA = 'Comandos: /estado · /pausa · /reanuda. (cerrar posiciones y cambiar de modo llegan en testnet)';

function renderEstado(positions: OpenPosition[]): string {
  if (positions.length === 0) return 'Estado: sin posiciones abiertas.';
  const lineas = positions.map((p) => `· ${p.symbol} @ ${p.entry} (size ${p.size}, sl ${p.sl ?? '—'} tp ${p.tp ?? '—'})`);
  return `Estado: ${positions.length} posición(es) abierta(s):\n${lineas.join('\n')}`;
}

// Ejecuta el comando (DETERMINISTA) y devuelve el texto de respuesta. SP11: solo comandos seguros
// (read + kill-switch). El LLM no llega aquí: solo clasificó la intención.
export async function dispatchControl(intent: ControlIntent, deps: DispatchDeps): Promise<string> {
  switch (intent.command) {
    case 'estado':
      return renderEstado(await deps.getOpenPositions());
    case 'pausa':
      await deps.setPaused(true);
      return '⏸️ Bot pausado: el scanner no disparará y los candidatos en cola no ejecutarán.';
    case 'reanuda':
      await deps.setPaused(false);
      return '▶️ Bot reanudado.';
    default:
      return AYUDA;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/control/dispatch-control.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/control/dispatch-control.ts src/lib/control/dispatch-control.test.ts
git commit -m "feat: dispatchControl (handlers deterministas de control, SP11)"
```

---

### Task 5: Enforcement del kill-switch (scan-tick + evaluateCandidate, H1)

**Files:**
- Modify: `src/lib/scanner/scan-tick.ts`
- Modify: `src/orchestration/evaluate-candidate.ts`
- Test: `src/lib/scanner/scan-tick.test.ts`, `src/orchestration/evaluate-candidate.test.ts`

**Interfaces:**
- Consumes: `getPaused` (Task 3).
- Produces: `ScanTickDeps` gana `isPaused: () => Promise<boolean>`; `EvaluateDeps` gana `isPaused: () => Promise<boolean>`. Ambos default `getPaused`.

- [ ] **Step 1: Write the failing tests**

En `src/lib/scanner/scan-tick.test.ts`, añade:

```ts
  test('pausado → no recorre estrategias, retorna ceros y audita scan_paused', async () => {
    const getStrategies = vi.fn(async () => []);
    const onError = vi.fn(async () => {});
    const result = await runScanTick(new Date('2026-06-29T00:00:00Z'), {
      isPaused: async () => true, getStrategies, scan: vi.fn(), enqueue: vi.fn(), onError, onEnqueueError: vi.fn(),
    });
    expect(result).toEqual({ scanned: 0, fired: 0, enqueued: 0 });
    expect(getStrategies).not.toHaveBeenCalled();
  });
```

En `src/orchestration/evaluate-candidate.test.ts`, añade (junto a los tests existentes; usa el patrón de deps que ya emplee el archivo):

```ts
  test('kill-switch ON: retorna skipped sin ejecutar (H1)', async () => {
    const notify = vi.fn(async () => ({ messageId: null }));
    const r = await evaluateCandidate('cualquier-signal', { isPaused: async () => true, notify });
    expect(r.kind).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/kill-switch/i);
    expect(notify).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/scanner/scan-tick.test.ts src/orchestration/evaluate-candidate.test.ts`
Expected: FAIL — `isPaused` no existe en las deps.

- [ ] **Step 3: Modify `scan-tick.ts`**

Añade el import `import { getPaused } from '../../db/repositories/bot-state.ts';`, el campo a `ScanTickDeps`:

```ts
  /** Kill-switch: si true, el tick no dispara (optimización: evita encolar). Default getPaused. */
  isPaused: () => Promise<boolean>;
```

Añade `isPaused: getPaused` a `DEFAULT_DEPS`. Al inicio de `runScanTick`, tras `const resolved = ...`:

```ts
  if (await resolved.isPaused()) {
    try {
      await appendAuditLog({ eventType: 'scan_paused', actor: 'scan_tick', payload: { asOf: asOf.toISOString() } });
    } catch { /* best-effort */ }
    return { scanned: 0, fired: 0, enqueued: 0 };
  }
```

- [ ] **Step 4: Modify `evaluate-candidate.ts` (H1)**

Añade el import `import { getPaused } from '../db/repositories/bot-state.ts';`, el campo a `EvaluateDeps`:

```ts
  isPaused: () => Promise<boolean>;
```

Añade `isPaused: getPaused` a `DEFAULT_DEPS`. Al inicio de `evaluateCandidate`, tras `const mode = getMode();`:

```ts
  // H1: kill-switch duro — bloquea la ejecución de jobs ya encolados antes de /pausa (§53).
  if (await isPaused()) {
    try {
      await appendAuditLog({ eventType: 'kill_switch_blocked', actor: 'evaluate-candidate', payload: { signalId, mode } });
    } catch { /* best-effort */ }
    return { kind: 'skipped', reason: 'kill-switch: bot pausado' };
  }
```

(Recuerda desestructurar `isPaused` del merge de deps: `const { notify, riskState, isPaused } = { ...DEFAULT_DEPS, ...deps };`.)

- [ ] **Step 5: Actualizar los tests UNITARIOS existentes de scan-tick (M-1)**

`src/lib/scanner/scan-tick.test.ts` es **unit puro** (no tiene `beforeAll(migrate)`). Con el default
`isPaused: getPaused` (que lee `bot_state` de la DB), los 4 tests existentes que NO inyectan `isPaused`
intentarían leer la DB. Añade `isPaused: async () => false` al objeto de deps de **cada** uno de los 4
tests existentes de scan-tick, para mantenerlos como unit sin DB. (Los tests de evaluate-candidate son
de integración con `migrate()`, así que ahí el default `getPaused` lee el singleton=false sin problema
— no requieren cambio salvo el test nuevo de H1.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/lib/scanner/scan-tick.test.ts src/orchestration/evaluate-candidate.test.ts && npm run typecheck`
Expected: tests PASS (nuevos + existentes verdes); typecheck verde.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scanner/scan-tick.ts src/orchestration/evaluate-candidate.ts src/lib/scanner/scan-tick.test.ts src/orchestration/evaluate-candidate.test.ts
git commit -m "feat: kill-switch en scan-tick + evaluateCandidate (hard stop H1, SP11)"
```

---

### Task 6: Skill `control-protocol` + workflow `control-maker`

**Files:**
- Create: `src/skills/control-protocol/SKILL.md`
- Create: `src/workflows/control-maker.ts`

**Interfaces:**
- Consumes: `ControlIntentSchema` (Task 1); `dispatchControl`/`DispatchDeps` (Task 4); `sendWhatsApp` (`../notify/whatsapp.ts`); `getOpenPositions`/`setPaused` (repos).
- Produces: workflow `control-maker` (`input: { text, sender }`). Tarea 7 lo invoca. Agente Haiku `low`, `tools: []`.

> Glue validado por typecheck + smoke (sin unit propio; parse/dispatch ya testeados). Flue-discovery: el workflow va plano en `src/workflows/`; el skill en `src/skills/control-protocol/`.

- [ ] **Step 1: Crear `src/skills/control-protocol/SKILL.md`**

```markdown
---
name: control-protocol
description: Protocolo del agente de control de Kairos. Clasifica un mensaje de WhatsApp del operador en uno de los comandos soportados (estado, pausa, reanuda) o unknown. No ejecuta nada — solo clasifica intención.
---

# Protocolo de control (Kairos)

Eres el **agente de control** de un bot de trading. Recibes un mensaje de texto del operador
autorizado y debes **clasificar su intención** en exactamente uno de estos comandos. **No ejecutas
nada**: solo emites el comando; otra capa (determinista) lo ejecuta.

## Comandos

- `estado` — el operador pide ver el estado: posiciones abiertas, P&L, exposición, "cómo va", "qué tienes abierto".
- `pausa` — el operador quiere detener el bot: "pausa", "para", "detén el scanner", "no abras más".
- `reanuda` — el operador quiere reactivar: "reanuda", "sigue", "vuelve a operar".
- `unknown` — cualquier otra cosa, incluido lo **no soportado todavía** (cerrar una posición, cambiar
  de modo sim/testnet/live) o lo ambiguo. Ante la duda, `unknown` (la capa determinista responderá
  con la ayuda).

## Salida

Emite **solo** el objeto estructurado `{ command }` con uno de los cuatro valores. No añadas prosa.
Ante peticiones que muevan dinero (cerrar, cambiar modo), responde `unknown` — esos comandos no están
disponibles en esta versión.
```

- [ ] **Step 2: Crear `src/workflows/control-maker.ts`**

```ts
import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import controlProtocol from '../skills/control-protocol/SKILL.md' with { type: 'skill' };
import { ControlIntentSchema, type ControlIntent } from '../lib/control/control-intent-schema.ts';
import { dispatchControl } from '../lib/control/dispatch-control.ts';
import { getOpenPositions } from '../db/repositories/positions.ts';
import { setPaused } from '../db/repositories/bot-state.ts';
import { getMode } from '../lib/mode.ts';
import { sendWhatsApp } from '../notify/whatsapp.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

const CONTROL_MODEL = process.env.CONTROL_MODEL ?? 'anthropic/claude-haiku-4-5';

// Agente de control: clasifica intención. tools:[] = línea roja (no ejecuta; el código despacha).
const controlAgent = defineAgent(() => ({
  model: CONTROL_MODEL,
  thinkingLevel: 'low',
  skills: [controlProtocol],
  tools: [],
}));

// Interfaz mínima de sesión para session.skill con result.
interface SkillSession {
  skill(name: string, opts: { args: Record<string, unknown>; result: unknown }): Promise<{ data: ControlIntent }>;
}

export default defineWorkflow({
  agent: controlAgent,
  input: v.object({ text: v.string(), sender: v.string() }),
  output: v.object({ command: v.picklist(['estado', 'pausa', 'reanuda', 'unknown']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    // L3: si el skill no produce un ControlIntent válido, degrada a 'unknown' (responde ayuda).
    let intent: ControlIntent = { command: 'unknown' };
    try {
      const res = await session.skill('control-protocol', { args: { text: input.text }, result: ControlIntentSchema });
      intent = res.data;
    } catch (err: unknown) {
      try {
        await appendAuditLog({ eventType: 'control_parse_failed', actor: 'control-maker',
          payload: { sender: input.sender, error: err instanceof Error ? err.message : String(err) } });
      } catch { /* best-effort */ }
    }
    // H-1: getOpenPositions exige `mode`; se envuelve con getMode() para satisfacer DispatchDeps.
    const reply = await dispatchControl(intent, { getOpenPositions: () => getOpenPositions(getMode()), setPaused });
    try {
      await sendWhatsApp(reply, input.sender);
    } catch { /* best-effort: el control no tumba nada si Evolution falla */ }
    return { command: intent.command };
  },
});
```

- [ ] **Step 3: Typecheck + suite**

Run: `npm run typecheck && npm test`
Expected: typecheck verde; suite verde. (El import del skill bajo vitest no muerde: ningún test importa `control-maker.ts`.)

> **Verifica la línea roja:** `controlAgent` lleva `tools: []`.

- [ ] **Step 4: Commit**

```bash
git add src/skills/control-protocol/SKILL.md src/workflows/control-maker.ts
git commit -m "feat: control-protocol skill + control-maker workflow (Haiku low, tools:[], SP11)"
```

---

### Task 7: Cableado del webhook (fromMe, ack-then-process, dispatch) + ARCHITECTURE

**Files:**
- Modify: `src/channels/evolution.ts`
- Test: `src/channels/__tests__/evolution.test.ts`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: `parseSlashCommand` (Task 2); `dispatchControl`/`DispatchDeps` (Task 4); `getOpenPositions`/`setPaused`; `sendWhatsApp`; `invoke` + `controlMaker` (Task 6); `appendAuditLog`.
- Produces: webhook que rutea inbound a control. Validado por test del canal + typecheck.

> El test va en `src/channels/__tests__/evolution.test.ts` (subdir que Flue ignora; el canal plano `evolution.ts` es descubierto).

- [ ] **Step 1: Write the failing tests**

Añade a `src/channels/__tests__/evolution.test.ts` (mockeando el workflow y los handlers para no tocar Flue/DB):

```ts
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../workflows/control-maker.ts', () => ({ default: {} }));
vi.mock('@flue/runtime', () => ({ invoke: vi.fn() }));

import { isFromMe, extractMessageText, processControlMessage } from '../evolution.ts';

describe('isFromMe (H2)', () => {
  test('detecta fromMe true/false', () => {
    expect(isFromMe({ data: { key: { fromMe: true } } })).toBe(true);
    expect(isFromMe({ data: { key: { fromMe: false } } })).toBe(false);
    expect(isFromMe({})).toBe(false);
  });
});

describe('extractMessageText (L2)', () => {
  test('lee conversation y extendedTextMessage.text', () => {
    expect(extractMessageText({ data: { message: { conversation: '/estado' } } })).toBe('/estado');
    expect(extractMessageText({ data: { message: { extendedTextMessage: { text: 'hola' } } } })).toBe('hola');
    expect(extractMessageText({ data: { message: {} } })).toBeNull();
  });
});

describe('processControlMessage', () => {
  test('comando slash → dispatch + reply (sin invoke)', async () => {
    const dispatch = vi.fn(async () => 'OK estado');
    const reply = vi.fn(async () => {});
    const invoke = vi.fn();
    await processControlMessage('/estado', '123', { dispatch, reply, invoke } as never);
    expect(dispatch).toHaveBeenCalledWith({ command: 'estado' }, expect.anything());
    expect(reply).toHaveBeenCalledWith('OK estado', '123');
    expect(invoke).not.toHaveBeenCalled();
  });
  test('texto libre → invoke (sin dispatch directo)', async () => {
    const dispatch = vi.fn();
    const reply = vi.fn();
    const invoke = vi.fn(async () => {});
    await processControlMessage('¿cómo va?', '123', { dispatch, reply, invoke } as never);
    expect(invoke).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
```

**(M-2)** Además, añade un caso al `describe('handleEvolutionWebhook')` existente que verifique la
guardia H2 cableada en el webhook (no solo el helper):

```ts
  test('fromMe true → 200 sin procesar (H2 cableado en el webhook)', async () => {
    const body = { data: { key: { remoteJid: `${process.env.WHATSAPP_CONTROL_NUMBER ?? '111'}@s.whatsapp.net`, fromMe: true } } };
    // headers(...) = el helper que el archivo ya usa para construir la firma válida.
    const res = await handleEvolutionWebhook(headers(process.env.EVOLUTION_WEBHOOK_SECRET ?? 'test'), body);
    expect(res.status).toBe(200);
  });
```
(Ajusta `headers(...)` y el secreto al patrón que el archivo ya usa para los tests de
`handleEvolutionWebhook`; el punto es: `fromMe:true` retorna 200 antes de procesar.)

(Conserva los tests existentes del archivo — verifyEvolutionWebhook/extractSenderNumber/isAuthorizedSender/handleEvolutionWebhook.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/__tests__/evolution.test.ts`
Expected: FAIL — `isFromMe`/`extractMessageText`/`processControlMessage` no existen.

- [ ] **Step 3: Modify `evolution.ts`**

Añade los helpers y `processControlMessage`, y cablea `handleEvolutionWebhook`. Inserta tras `isAuthorizedSender`:

```ts
import { parseSlashCommand } from '../lib/control/parse-control.ts';
import { dispatchControl, type DispatchDeps } from '../lib/control/dispatch-control.ts';
import { getOpenPositions } from '../db/repositories/positions.ts';
import { setPaused } from '../db/repositories/bot-state.ts';
import { getMode } from '../lib/mode.ts';
import { sendWhatsApp } from '../notify/whatsapp.ts';

// H2: descarta la propia respuesta saliente del bot (evita el lazo de realimentación).
export function isFromMe(body: unknown): boolean {
  return (body as { data?: { key?: { fromMe?: boolean } } })?.data?.key?.fromMe === true;
}

// L2: extrae el texto del mensaje (dos formas reales del payload Evolution).
export function extractMessageText(body: unknown): string | null {
  const m = (body as { data?: { message?: { conversation?: string; extendedTextMessage?: { text?: string } } } })?.data?.message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? null;
}

interface ControlRouteDeps {
  dispatch: (intent: { command: 'estado' | 'pausa' | 'reanuda' | 'unknown' }, deps: DispatchDeps) => Promise<string>;
  reply: (text: string, to: string) => Promise<unknown>;
  invoke: (text: string, sender: string) => Promise<unknown>;
}

const DEFAULT_ROUTE: ControlRouteDeps = {
  dispatch: dispatchControl,
  reply: (text, to) => sendWhatsApp(text, to),
  invoke: async (text, sender) => {
    const { invoke } = await import('@flue/runtime');
    const controlMaker = (await import('../workflows/control-maker.ts')).default;
    return invoke(controlMaker, { input: { text, sender } });
  },
};

// Rutea el mensaje: comando slash → dispatch determinista + reply; texto libre → invoke (LLM).
export async function processControlMessage(
  text: string, sender: string, route: ControlRouteDeps = DEFAULT_ROUTE,
): Promise<void> {
  const slash = parseSlashCommand(text);
  if (slash) {
    // H-1: getOpenPositions exige `mode`; se envuelve con getMode().
    const replyText = await route.dispatch(slash, { getOpenPositions: () => getOpenPositions(getMode()), setPaused });
    await route.reply(replyText, sender);
  } else {
    await route.invoke(text, sender);   // texto libre → control-maker (Haiku)
  }
}
```

Reemplaza el cuerpo de `handleEvolutionWebhook` (tras la verificación de firma) por:

```ts
  if (!verifyEvolutionWebhook(headers)) return { status: 401 };
  if (isFromMe(body)) return { status: 200 };           // H2
  const sender = extractSenderNumber(body);
  if (!isAuthorizedSender(sender)) return { status: 200 };
  await appendAuditLog({ eventType: 'whatsapp.inbound', actor: sender ?? 'unknown', payload: { received: true } });
  const text = extractMessageText(body);
  if (text && sender) {
    // M2: ack-then-process — no bloquear el 200 con DB/fetch saliente; best-effort.
    void processControlMessage(text, sender).catch((err) => {
      void appendAuditLog({ eventType: 'control_dispatch_failed', actor: sender,
        payload: { error: err instanceof Error ? err.message : String(err) } }).catch(() => {});
    });
  }
  return { status: 200 };
```

- [ ] **Step 4: Editar `ARCHITECTURE.md` (M1 — desviación)**

En §11 (Flujo C) y §65 (tabla de agentes) y §393-396 (árbol de archivos), añade una nota: "**(SP11)** El
control se implementa como **workflow** `workflows/control-maker.ts` invocado con `invoke()` (no un
agente continuo `dispatch`): cada comando es stateless, y Flue recomienda un workflow finito cuando el
trabajo no continúa entre mensajes. El parsing slash es determinista (sin LLM); el LLM (Haiku low) solo
clasifica texto libre." No reescribas las secciones enteras — añade la nota junto al texto existente.

- [ ] **Step 5: Typecheck + suite completa**

Run: `npm run typecheck && npm test`
Expected: typecheck verde; suite verde (incluye los tests del canal). Cobertura ≥ 80%.

- [ ] **Step 6: Commit**

```bash
git add src/channels/evolution.ts src/channels/__tests__/evolution.test.ts ARCHITECTURE.md
git commit -m "feat: webhook rutea control (fromMe + ack-then-process + dispatch/invoke, SP11)"
```

- [ ] **Step 7: Smoke (owner-gated o flue run)**

**Opción A (sin Evolution, valida el LLM):** `npx flue run control-maker --target node --input '{"text":"pausa el bot por favor","sender":"<tu número de control>"}'` → debe clasificar `command: 'pausa'`, llamar `setPaused(true)` y enviar la respuesta (si Evolution está configurado) o al menos completar. Verifica `SELECT paused FROM kairos.bot_state;` → `true`. Luego `flue run control-maker --input '{"text":"reanuda","sender":"..."}'` → `false`.

**Opción B (end-to-end, requiere Evolution vivo + tu WhatsApp):** envía `/estado` y "¿cómo va?" desde el número de control; verifica la respuesta. Requiere la instancia Evolution alcanzable y el webhook registrado — owner-gated.

> Limpieza tras el smoke: `setPaused(false)` para no dejar el bot pausado.

---

## Notas de cierre (post-implementación)

Tras Task 7: `CLAUDE.md` (bullet SP11 — **Fase 2 COMPLETA**) y el ledger SDD. SP11 cierra Fase 2;
`/cierra` y `/modo` quedan para testnet (junto al plumbing de órdenes real).
