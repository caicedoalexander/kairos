# Kairos — Fase 0 (Andamiaje) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el esqueleto de Kairos en pie y verificado — proyecto Flue (Node target), store Postgres, esquema de dominio `kairos`, cliente ccxt y canal Evolution + `send_whatsapp` — sin ninguna lógica de trading todavía.

**Architecture:** Servicio Node de Flue (`src/`) descubierto por archivos: `app.ts` (health + montaje de Flue), `db.ts` (store `@flue/postgres` con `pg` Pool compartido), `channels/evolution.ts` (ingreso WhatsApp custom). El dominio (posiciones/señales/órdenes/…) vive en un esquema propio `kairos` del mismo Postgres, poblado por repositorios append-first; Flue solo guarda sus tablas `flue_*`. El cliente de exchange se separa en dos (público sin clave / autenticado con credencial en closure). Toda la Fase 0 es determinista: cero LLM, cero agentes, cero mutación de dinero.

**Tech Stack:** TypeScript ESM, Flue `@flue/runtime` 1.0.0-beta.5 (target Node), `@flue/postgres` + `pg` (PostgreSQL), `ccxt` (Binance Spot), `hono` (rutas), Valibot (validación), Vitest (tests + cobertura v8), Evolution API (WhatsApp vía REST). Docker Compose local para Postgres + Redis.

## Global Constraints

Cada task hereda implícitamente estas reglas (valores verbatim de `ARCHITECTURE.md` y `CLAUDE.md`):

- **Node ≥ 22.19.0** — piso de motor exigido por `@flue/runtime` (`engines.node`). El `Dockerfile` se fija en `node:22.19-slim` o superior.
- **Validación con Valibot, NO zod** — `input`/`output` de tools y todo I/O en límites de sistema.
- **Verificar la API de Flue/ccxt contra su doc real, nunca de memoria** — Flue en `node_modules/@flue/runtime/docs/` y `types/`; ccxt vía el skill `.claude/skills/ccxt-typescript`. Ante duda de firma, abrir la doc antes de escribir.
- **Flue no persiste datos de dominio** → todo lo de dominio va al esquema `kairos`, **append-first**; Flue solo gestiona `flue_*`.
- **Los canales no deduplican** → la idempotencia es de la app (relevante para el canal en esta fase: registrar, no asumir entrega única).
- **Líneas rojas de seguridad** (aunque la mayoría se materializan en Fases 1–2, ya se respetan aquí): ninguna tool de mutación (`execute_order`, `close_position`, `cancel_order`, `set_stop_take`, `check_risk`) en el `tools:[]` de un modelo; toda orden con `idempotency_key UNIQUE`; credenciales del exchange y account-id en **closures**, nunca en el `input` del modelo; modo `sim|testnet|live` **explícito y persistido**, `sim` por defecto.
- **Estilo**: funciones < 50 líneas, archivos < 800, anidamiento ≤ 4, inmutabilidad por defecto, validación en los límites, sin secretos hardcodeados, sin `console.log` de debug (sí `console.error` en el path de error de un CLI).
- **Idioma**: documentación, comentarios y mensajes de commit en español; identificadores de código en inglés.
- **Tests**: TDD (rojo→verde→refactor), cobertura ≥ 80 %.
- **Fuente de verdad del diseño**: `ARCHITECTURE.md` §7 (clientes/tools), §8 (esquema), §10 (modos), §12 (estructura), §13 (fases).

> Prerrequisitos de entorno para correr los tests de integración: Docker disponible (para `docker compose up`), o un PostgreSQL y Redis locales accesibles por las URLs de `.env`.

---

### Task 1: Bootstrap del proyecto Flue (Node target)

Deja `flue build`/`flue dev` funcionando, las dependencias base instaladas, la config de TypeScript/Vitest y un endpoint `/health` testeable. No depende de ccxt ni de la DB.

**Files:**
- Modify: `package.json` (scripts, `engines`, `type`, deps base)
- Create: `flue.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `docker-compose.yml`
- Create: `src/lib/mode.ts`
- Create: `src/health.ts`
- Create: `src/app.ts`
- Test: `src/health.test.ts`

**Interfaces:**
- Produces: `getMode(): TradingMode` y `type TradingMode = 'sim' | 'testnet' | 'live'` desde `src/lib/mode.ts`. Default `sim`; lanza si el valor de `KAIROS_MODE` es inválido. Lo consumen Task 5 (ccxt-client), `src/health.ts` y `src/app.ts`.
- Produces: `src/health.ts` default-exporta una app Hono con `GET /health` (testeable sin tocar `flue()`).
- Produces: `src/app.ts` default-exporta una app Hono que compone `health` + `flue()` montado en `/`.

- [ ] **Step 1: Verificar la versión de Node**

Run: `node -v`
Expected: `v22.19.0` o superior. Si es menor (el entorno trae `v22.17.1`), instalar Node ≥ 22.19 (p. ej. `nvm install 22.19 && nvm use 22.19`) antes de continuar — Flue lo exige en `engines`.

- [ ] **Step 2: Instalar dependencias base de desarrollo y runtime**

Run:
```bash
npm install hono valibot
npm install -D typescript vitest @vitest/coverage-v8 @types/node dotenv
```
Expected: instalación sin errores; `hono`, `valibot` en `dependencies`, el resto en `devDependencies`.

- [ ] **Step 3: Fijar `package.json` (scripts, engines, type)**

Edita `package.json` para que quede así (conserva las versiones exactas que `npm install` haya escrito):
```json
{
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "dev": "flue dev --target node",
    "build": "flue build --target node",
    "start": "node dist/server.mjs",
    "migrate": "node --experimental-strip-types src/db/migrate.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@flue/runtime": "^1.0.0-beta.5",
    "hono": "^4.8.3",
    "valibot": "^1.1.0"
  },
  "devDependencies": {
    "@flue/cli": "^1.0.0-beta.5",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^4.0.0",
    "dotenv": "^16.0.0",
    "typescript": "^6.0.0",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 4: Crear `flue.config.ts`**

```ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

- [ ] **Step 5: Crear `tsconfig.json`**

Sintaxis borrable (el server lo construye Vite; `tsc` solo type-checa). `allowImportingTsExtensions` porque los imports usan extensión `.ts` (como en la doc de Flue).
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src", "flue.config.ts", "vitest.config.ts", "vitest.setup.ts"]
}
```

- [ ] **Step 6: Crear `vitest.config.ts` y `vitest.setup.ts`**

`vitest.setup.ts` (carga `.env` para los tests de integración):
```ts
import 'dotenv/config';
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
      exclude: ['dist/**', '**/*.test.ts', 'vitest.*.ts', 'flue.config.ts'],
    },
  },
});
```

- [ ] **Step 7: Crear `docker-compose.yml` para dependencias locales**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: kairos
    ports:
      - "5432:5432"
    volumes:
      - kairos_pg:/var/lib/postgresql/data

  redis:
    image: redis:7
    command: ["redis-server", "--maxmemory-policy", "noeviction"]
    ports:
      - "6379:6379"

volumes:
  kairos_pg:
```
> Nota: en producción, BullMQ exige una instancia/DB Redis con `noeviction` dedicada (§8). Esta compose local sirve para dev y tests.

- [ ] **Step 8: Crear `.env` a partir de la plantilla**

Run: `cp .env.example .env`
Expected: existe `.env` con `KAIROS_MODE=sim` y `DATABASE_URL=postgresql://user:password@localhost:5432/kairos`. No se commitea (ya está en `.gitignore`).

- [ ] **Step 9: Escribir el test de `/health` (RED)**

Se testea `health.ts` aislado (sin `flue()`) para no depender del build de Vite en Vitest.

`src/health.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import health from './health.ts';

describe('health', () => {
  test('GET /health responde 200 con status ok y el modo actual', async () => {
    const res = await health.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(['sim', 'testnet', 'live']).toContain(body.mode);
  });
});
```

- [ ] **Step 10: Ejecutar el test y verificar que falla**

Run: `npx vitest run src/health.test.ts`
Expected: FALLA por módulos inexistentes (`./health.ts`, `./lib/mode.ts` aún no existen).

- [ ] **Step 11: Crear `src/lib/mode.ts`**

```ts
export type TradingMode = 'sim' | 'testnet' | 'live';

const VALID_MODES: readonly TradingMode[] = ['sim', 'testnet', 'live'];

// Modo de ejecución explícito y persistido en config; 'sim' es el default seguro (§10).
export function getMode(): TradingMode {
  const value = process.env.KAIROS_MODE ?? 'sim';
  if (!VALID_MODES.includes(value as TradingMode)) {
    throw new Error(`KAIROS_MODE inválido: "${value}" (esperado sim|testnet|live)`);
  }
  return value as TradingMode;
}
```

- [ ] **Step 12: Crear `src/health.ts`**

```ts
import { Hono } from 'hono';
import { getMode } from './lib/mode.ts';

const health = new Hono();

health.get('/health', (c) => c.json({ status: 'ok', mode: getMode() }));

export default health;
```

- [ ] **Step 13: Crear `src/app.ts`**

```ts
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import health from './health.ts';

const app = new Hono();

// Rutas propias (health) + rutas generadas por Flue (agentes, workflows, canales) sin prefijo.
app.route('/', health);
app.route('/', flue());

export default app;
```

- [ ] **Step 14: Ejecutar el test y verificar que pasa**

Run: `npx vitest run src/health.test.ts`
Expected: PASA.

- [ ] **Step 15: Smoke de build del target Node**

Run: `npx flue build --target node`
Expected: build exitoso; existe `dist/server.mjs`. (No arranca el server todavía — eso necesita la DB de la Task 2.)

- [ ] **Step 16: Commit**

```bash
git add package.json package-lock.json flue.config.ts tsconfig.json vitest.config.ts vitest.setup.ts docker-compose.yml src/lib/mode.ts src/health.ts src/app.ts src/health.test.ts
git commit -m "chore: andamiaje del proyecto Flue (config, health, tooling de tests)"
```

---

### Task 2: Store de Flue en Postgres (`db.ts` + pool compartido)

Cablea el store de Flue a Postgres con `@flue/postgres` y un `pg` Pool, exportando ese pool para que los repositorios de dominio (Tasks 3–4) usen la misma conexión.

**Files:**
- Create: `src/db/pool.ts`
- Create: `src/db.ts`
- Test: `src/db/pool.test.ts`

**Interfaces:**
- Produces: `pool: Pool` y `query<T>(text, params?): Promise<T[]>` desde `src/db/pool.ts`. Lo consumen `src/db.ts`, `src/db/migrate.ts` (Task 3) y los repositorios (Task 4).
- Produces: `src/db.ts` default-exporta el `PersistenceAdapter` de Flue (descubierto en build).
- Consumes: `DATABASE_URL` del entorno.

- [ ] **Step 1: Verificar disponibilidad, obtener el blueprint e instalar el adapter Postgres**

Run:
```bash
npm view @flue/postgres version        # confirmar que existe (hoy: 1.0.0-beta.3)
npx flue add database postgres --print
npm install @flue/postgres pg
npm install -D @types/pg
```
Expected: `@flue/postgres` existe en el registro. Su versión (`beta.3`) **difiere** de la de `@flue/runtime` (`beta.5`) — es normal, son paquetes versionados aparte; **no** fijarlo a `^1.0.0-beta.5` (dejar que `npm install` resuelva la última `beta`). El blueprint confirma el patrón "bring your own driver"; `@flue/postgres` y `pg` quedan en `dependencies`, `@types/pg` en `devDependencies`.

> Fallback (solo si `@flue/postgres` no estuviera disponible): usar `sqlite('./data/flue.db')` de `@flue/runtime/node` como store de Flue y mantener el pool `pg` **solo** para el esquema `kairos` (doc: `guide/database.md` §"Choosing an adapter" — single-host → `sqlite()`). No es el caso hoy.

- [ ] **Step 2: Levantar Postgres local**

Run: `docker compose up -d postgres`
Expected: contenedor `postgres` arriba, escuchando en `localhost:5432`.

- [ ] **Step 3: Escribir el test del pool (RED)**

`src/db/pool.test.ts`:
```ts
import { describe, test, expect, afterAll } from 'vitest';
import { pool, query } from './pool.ts';

afterAll(async () => {
  await pool.end();
});

describe('pool', () => {
  test('query ejecuta SQL y devuelve filas tipadas', async () => {
    const rows = await query<{ one: number }>('SELECT 1 AS one');
    expect(rows[0]?.one).toBe(1);
  });
});
```

- [ ] **Step 4: Ejecutar el test y verificar que falla**

Run: `npx vitest run src/db/pool.test.ts`
Expected: FALLA (no existe `./pool.ts`).

- [ ] **Step 5: Crear `src/db/pool.ts`**

```ts
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está configurada');
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Helper de solo-lectura/escritura simple sobre el pool (los repos lo reutilizan).
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(text, params as never);
  return result.rows as T[];
}
```

- [ ] **Step 6: Crear `src/db.ts` (store de Flue, BYO-driver)**

```ts
import { postgres } from '@flue/postgres';
import { pool } from './db/pool.ts';

// Store de Flue (tablas flue_*): comparte el mismo pool que el dominio (esquema kairos).
// migrate() de Flue corre solo al arrancar el server Node y crea las flue_* idempotentemente.
export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async (text, params) => (await client.query(text, params)).rows,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
```

- [ ] **Step 7: Ejecutar el test y verificar que pasa**

Run: `npx vitest run src/db/pool.test.ts`
Expected: PASA.

- [ ] **Step 8: Type-check del proyecto**

Run: `npm run typecheck`
Expected: sin errores de tipos.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/db.ts src/db/pool.ts src/db/pool.test.ts
git commit -m "feat: store de Flue en Postgres con pool pg compartido"
```

---

### Task 3: Esquema de dominio `kairos` (DDL + runner de migración)

Crea el esquema `kairos` con todas las tablas de `ARCHITECTURE.md` §8, append-first e idempotente, más un runner `npm run migrate`.

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/migrate.ts`
- Test: `src/db/migrate.test.ts`

**Interfaces:**
- Produces: `migrate(): Promise<void>` desde `src/db/migrate.ts` (lee y aplica `schema.sql`). Reutilizable por los tests y por `npm run migrate`.
- Consumes: `pool`/`query` de `src/db/pool.ts`.

- [ ] **Step 1: Escribir el test de migración (RED)**

`src/db/migrate.test.ts`:
```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from './migrate.ts';
import { pool, query } from './pool.ts';

const EXPECTED_TABLES = [
  'strategies', 'signals', 'decisions', 'risk_evaluations', 'orders', 'fills',
  'positions', 'account_snapshots', 'pending_approvals', 'audit_log',
  'ohlcv_candles', 'funding_rates', 'open_interest', 'liquidations', 'backtest_runs',
];

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

describe('migrate', () => {
  test('crea las 15 tablas del esquema kairos', async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'kairos'`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  test('orders.idempotency_key tiene restricción UNIQUE', async () => {
    const rows = await query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM information_schema.table_constraints
        WHERE table_schema = 'kairos' AND table_name = 'orders'
          AND constraint_type = 'UNIQUE'`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  test('es idempotente: aplicar de nuevo no falla', async () => {
    await expect(migrate()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: FALLA (no existe `./migrate.ts` ni `schema.sql`).

- [ ] **Step 3: Crear `src/db/schema.sql`**

```sql
-- Esquema de dominio de Kairos (append-first). Flue gestiona aparte sus tablas flue_*.
CREATE SCHEMA IF NOT EXISTS kairos;

-- Config declarativa de estrategias (hot-reloadable). trigger_config = árbol de reglas MTF (§16).
CREATE TABLE IF NOT EXISTS kairos.strategies (
  id             text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  timeframe      text NOT NULL,
  symbols        text[] NOT NULL DEFAULT '{}',
  trigger_config jsonb NOT NULL,
  risk_params    jsonb NOT NULL,
  skill_name     text,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Historial de señales disparadas por el scanner.
CREATE TABLE IF NOT EXISTS kairos.signals (
  id                 text PRIMARY KEY,
  strategy_id        text NOT NULL REFERENCES kairos.strategies(id),
  symbol             text NOT NULL,
  fired_at           timestamptz NOT NULL DEFAULT now(),
  indicator_snapshot jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'fired'
);
CREATE INDEX IF NOT EXISTS signals_symbol_fired_at_idx ON kairos.signals (symbol, fired_at DESC);

-- Razonamiento explícito del decision-maker (append-only).
CREATE TABLE IF NOT EXISTS kairos.decisions (
  id               text PRIMARY KEY,
  signal_id        text NOT NULL REFERENCES kairos.signals(id),
  verdict          jsonb NOT NULL,
  reasoning        text,
  technical_read   jsonb,
  fundamental_read jsonb,
  model_used       text,
  tokens           integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Auditoría del risk gate.
CREATE TABLE IF NOT EXISTS kairos.risk_evaluations (
  id              text PRIMARY KEY,
  decision_id     text NOT NULL REFERENCES kairos.decisions(id),
  result          text NOT NULL CHECK (result IN ('allow', 'deny', 'needs_approval')),
  reason          text,
  adjusted_size   numeric,
  limits_snapshot jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Órdenes: idempotency_key UNIQUE evita duplicados tras crash. purpose/parent_id ligan legs OCO (§18).
CREATE TABLE IF NOT EXISTS kairos.orders (
  id                text PRIMARY KEY,
  idempotency_key   text NOT NULL UNIQUE,
  decision_id       text REFERENCES kairos.decisions(id),
  side              text NOT NULL CHECK (side IN ('buy', 'sell')),
  size              numeric NOT NULL,
  type              text NOT NULL,
  tif               text,
  purpose           text NOT NULL CHECK (purpose IN ('entry', 'sl', 'tp')),
  parent_id         text,
  status            text NOT NULL DEFAULT 'pending',
  exchange_order_id text,
  mode              text NOT NULL CHECK (mode IN ('sim', 'testnet', 'live')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Reconciliación de llenados.
CREATE TABLE IF NOT EXISTS kairos.fills (
  id       text PRIMARY KEY,
  order_id text NOT NULL REFERENCES kairos.orders(id),
  price    numeric NOT NULL,
  qty      numeric NOT NULL,
  fee      numeric NOT NULL DEFAULT 0,
  ts       timestamptz NOT NULL DEFAULT now()
);

-- Posiciones (source of truth). mode aísla sim/testnet/live para el reconciler (§8).
CREATE TABLE IF NOT EXISTS kairos.positions (
  id           text PRIMARY KEY,
  symbol       text NOT NULL,
  side         text NOT NULL CHECK (side IN ('long')),
  entry        numeric NOT NULL,
  size         numeric NOT NULL,
  sl           numeric,
  tp           numeric,
  status       text NOT NULL DEFAULT 'open',
  realized_pnl numeric NOT NULL DEFAULT 0,
  strategy_id  text REFERENCES kairos.strategies(id),
  mode         text NOT NULL CHECK (mode IN ('sim', 'testnet', 'live')),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

-- Snapshots de cuenta para límites de pérdida diaria / drawdown desde el pico (§19).
CREATE TABLE IF NOT EXISTS kairos.account_snapshots (
  id          text PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  equity      numeric NOT NULL,
  peak_equity numeric NOT NULL,
  drawdown    numeric NOT NULL DEFAULT 0,
  daily_pnl   numeric NOT NULL DEFAULT 0
);

-- Circuit-breaker async, resuelto por WhatsApp (§19); NO es pausa de workflow.
CREATE TABLE IF NOT EXISTS kairos.pending_approvals (
  id          text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES kairos.decisions(id),
  reason      text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at  timestamptz NOT NULL,
  resolved_by text,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Rastro completo de eventos.
CREATE TABLE IF NOT EXISTS kairos.audit_log (
  id         text PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  actor      text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON kairos.audit_log (ts DESC);

-- Histórico de velas cerradas (alimenta backtest, §20).
CREATE TABLE IF NOT EXISTS kairos.ohlcv_candles (
  symbol    text NOT NULL,
  timeframe text NOT NULL,
  open_time timestamptz NOT NULL,
  o numeric NOT NULL,
  h numeric NOT NULL,
  l numeric NOT NULL,
  c numeric NOT NULL,
  v numeric NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time)
);

-- Funding histórico del perp (señal de solo-lectura, §15).
CREATE TABLE IF NOT EXISTS kairos.funding_rates (
  symbol text NOT NULL,
  ts     timestamptz NOT NULL,
  rate   numeric NOT NULL,
  PRIMARY KEY (symbol, ts)
);

-- Open interest histórico del perp (señal, §15).
CREATE TABLE IF NOT EXISTS kairos.open_interest (
  symbol   text NOT NULL,
  ts       timestamptz NOT NULL,
  oi       numeric NOT NULL,
  oi_value numeric,
  PRIMARY KEY (symbol, ts)
);

-- Liquidaciones del perp (señal, §15). Las crudas se retienen a corto plazo (§15.3).
CREATE TABLE IF NOT EXISTS kairos.liquidations (
  id       text PRIMARY KEY,
  symbol   text NOT NULL,
  ts       timestamptz NOT NULL,
  side     text NOT NULL CHECK (side IN ('long', 'short')),
  price    numeric NOT NULL,
  qty      numeric NOT NULL,
  notional numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS liquidations_symbol_ts_idx ON kairos.liquidations (symbol, ts DESC);

-- Resultado reproducible de un backtest (§20).
CREATE TABLE IF NOT EXISTS kairos.backtest_runs (
  id               text PRIMARY KEY,
  strategy_id      text NOT NULL REFERENCES kairos.strategies(id),
  strategy_version integer NOT NULL,
  window           tstzrange,
  mode             text NOT NULL CHECK (mode IN ('det', 'llm')),
  sim_params       jsonb NOT NULL,
  metrics          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Crear `src/db/migrate.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './pool.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Aplica el esquema de dominio kairos (idempotente). Las flue_* las migra Flue al arrancar.
export async function migrate(): Promise<void> {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Entrypoint CLI: `npm run migrate`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Migración fallida:', error);
      process.exit(1);
    });
}
```

- [ ] **Step 5: Ejecutar el test y verificar que pasa**

Run: `npx vitest run src/db/migrate.test.ts`
Expected: PASA (15 tablas, UNIQUE en `orders`, idempotente).

- [ ] **Step 6: Verificar el runner CLI**

Run: `npm run migrate`
Expected: termina con código 0 (sin salida de error).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/migrate.ts src/db/migrate.test.ts
git commit -m "feat: esquema de dominio kairos y runner de migración idempotente"
```

---

### Task 4: Patrón de repositorio + repo `audit_log`

Establece el patrón de acceso append-first del dominio con el repositorio transversal `audit_log` (lo usan todas las capas). Los repos por-tabla de trading se añaden en las fases que los consumen (YAGNI).

**Files:**
- Create: `src/db/repositories/audit-log.ts`
- Test: `src/db/repositories/audit-log.test.ts`

**Interfaces:**
- Produces: `appendAuditLog(entry: AuditLogEntry): Promise<string>` (devuelve el `id` ULID generado) y `type AuditLogEntry = { eventType: string; actor: string; payload?: Record<string, unknown> }` desde `src/db/repositories/audit-log.ts`. Lo consume Task 7 (canal Evolution) y, más adelante, executor/risk/monitor.
- Consumes: `query` de `src/db/pool.ts`; `ulid()` de `ulidx` (dependencia transitiva de `@flue/runtime`).

- [ ] **Step 1: Declarar `ulidx` como dependencia directa y escribir el test del repo (RED)**

`ulidx` ya viene como dependencia transitiva de `@flue/runtime`, pero se declara directa para que `tsc` y futuras versiones de Flue no rompan la importación.

Run: `npm install ulidx`

`src/db/repositories/audit-log.test.ts`:
```ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { appendAuditLog } from './audit-log.ts';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

describe('appendAuditLog', () => {
  test('inserta una entrada y la devuelve por id', async () => {
    const id = await appendAuditLog({
      eventType: 'test.event',
      actor: 'vitest',
      payload: { hello: 'world' },
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // formato ULID

    const rows = await query<{ event_type: string; actor: string; payload: { hello: string } }>(
      `SELECT event_type, actor, payload FROM kairos.audit_log WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.event_type).toBe('test.event');
    expect(rows[0]?.actor).toBe('vitest');
    expect(rows[0]?.payload.hello).toBe('world');
  });

  test('payload por defecto es objeto vacío', async () => {
    const id = await appendAuditLog({ eventType: 'test.empty', actor: 'vitest' });
    const rows = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM kairos.audit_log WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.payload).toEqual({});
  });
});
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npx vitest run src/db/repositories/audit-log.test.ts`
Expected: FALLA (no existe `./audit-log.ts`).

- [ ] **Step 3: Crear `src/db/repositories/audit-log.ts`**

```ts
import { ulid } from 'ulidx';
import { query } from '../pool.ts';

export interface AuditLogEntry {
  eventType: string;
  actor: string;
  payload?: Record<string, unknown>;
}

// Append-first: el rastro de auditoría solo crece, nunca se actualiza ni borra.
export async function appendAuditLog(entry: AuditLogEntry): Promise<string> {
  const id = ulid();
  await query(
    `INSERT INTO kairos.audit_log (id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4)`,
    [id, entry.eventType, entry.actor, JSON.stringify(entry.payload ?? {})],
  );
  return id;
}
```

- [ ] **Step 4: Ejecutar el test y verificar que pasa**

Run: `npx vitest run src/db/repositories/audit-log.test.ts`
Expected: PASA.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/db/repositories/audit-log.ts src/db/repositories/audit-log.test.ts
git commit -m "feat: patrón de repositorio append-first con repo audit_log"
```

---

### Task 5: Cliente ccxt (dos clientes: público / autenticado en closure)

Crea la separación de clientes de §7: uno público sin clave (ingester + read tools) y otro autenticado con la credencial en closure (mutación + balance/estado), con el sandbox de Binance activo salvo en `live`.

**Files:**
- Create: `src/lib/ccxt-client.ts`
- Test: `src/lib/ccxt-client.test.ts`

**Interfaces:**
- Produces: `createPublicClient(): Exchange` (sin API key) y `createAuthenticatedClient(): Exchange` (apiKey/secret desde env, en closure; `setSandboxMode(true)` salvo en `live`) desde `src/lib/ccxt-client.ts`.
- Consumes: `getMode()` de `src/lib/mode.ts`; `ccxt`.

> Verificación (ccxt): confirmar `new ccxt.binance(...)`, `enableRateLimit`, `setSandboxMode` y el tipo `Exchange` contra el skill `.claude/skills/ccxt-typescript` antes de dar por buena la firma.

- [ ] **Step 1: Instalar ccxt**

Run: `npm install ccxt`
Expected: `ccxt` en `dependencies`.

- [ ] **Step 2: Escribir el test del cliente (RED)**

`src/lib/ccxt-client.test.ts`:
```ts
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createPublicClient, createAuthenticatedClient } from './ccxt-client.ts';

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('ccxt-client', () => {
  test('el cliente público no lleva API key', () => {
    const client = createPublicClient();
    expect(client.apiKey ?? '').toBe('');
  });

  test('el cliente autenticado toma la credencial del entorno', () => {
    vi.stubEnv('KAIROS_MODE', 'testnet');
    vi.stubEnv('BINANCE_API_KEY', 'k-123');
    vi.stubEnv('BINANCE_API_SECRET', 's-456');
    const client = createAuthenticatedClient();
    expect(client.apiKey).toBe('k-123');
    expect(client.secret).toBe('s-456');
  });

  test('lanza si faltan las credenciales del exchange', () => {
    vi.stubEnv('KAIROS_MODE', 'testnet');
    vi.stubEnv('BINANCE_API_KEY', '');
    vi.stubEnv('BINANCE_API_SECRET', '');
    expect(() => createAuthenticatedClient()).toThrow();
  });
});
```

- [ ] **Step 3: Ejecutar el test y verificar que falla**

Run: `npx vitest run src/lib/ccxt-client.test.ts`
Expected: FALLA (no existe `./ccxt-client.ts`).

- [ ] **Step 4: Crear `src/lib/ccxt-client.ts`**

```ts
import ccxt, { type Exchange } from 'ccxt';
import { getMode } from './mode.ts';

// Cliente PÚBLICO (sin API key): ingester de market-data y read tools de datos públicos (§7).
export function createPublicClient(): Exchange {
  return new ccxt.binance({ enableRateLimit: true });
}

// Cliente AUTENTICADO: credencial en closure, solo mutación + balance/estado (§7).
// El modelo nunca ve estas claves ni elige la cuenta.
export function createAuthenticatedClient(): Exchange {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) {
    throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET no configuradas');
  }
  const client = new ccxt.binance({ apiKey, secret, enableRateLimit: true });
  // sim y testnet usan el sandbox de Binance; solo live toca producción (§10).
  if (getMode() !== 'live') {
    client.setSandboxMode(true);
  }
  return client;
}
```

- [ ] **Step 5: Ejecutar el test y verificar que pasa**

Run: `npx vitest run src/lib/ccxt-client.test.ts`
Expected: PASA.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/ccxt-client.ts src/lib/ccxt-client.test.ts
git commit -m "feat: clientes ccxt separados (público / autenticado en closure)"
```

---

### Task 6: Salida WhatsApp `send_whatsapp` (REST de Evolution)

Implementa el envío de WhatsApp por el REST de Evolution como función determinista (la usa el notificador por template) y expone además un `defineTool` para uso futuro del agente de control.

**Files:**
- Create: `src/notify/whatsapp.ts`
- Test: `src/notify/whatsapp.test.ts`

**Interfaces:**
- Produces: `sendWhatsApp(text: string, to?: string): Promise<{ messageId: string | null }>` y el tool `sendWhatsappTool` (name `send_whatsapp`) desde `src/notify/whatsapp.ts`.
- Consumes: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `WHATSAPP_CONTROL_NUMBER` del entorno; `defineTool` de `@flue/runtime`; Valibot.

> Verificación (Evolution): la ruta `POST /message/sendText/{instance}`, el header `apikey` y el body `{ number, text }` corresponden a Evolution API v2. Confirmar contra la versión real de la instancia; el test fija NUESTRO contrato (mock de `fetch`), no el de Evolution.

- [ ] **Step 1: Escribir el test del envío (RED)**

`src/notify/whatsapp.test.ts`:
```ts
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendWhatsApp } from './whatsapp.ts';

beforeEach(() => {
  vi.stubEnv('EVOLUTION_API_URL', 'https://evo.test');
  vi.stubEnv('EVOLUTION_API_KEY', 'evo-key');
  vi.stubEnv('EVOLUTION_INSTANCE', 'kairos');
  vi.stubEnv('WHATSAPP_CONTROL_NUMBER', '573001234567');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sendWhatsApp', () => {
  test('hace POST al endpoint de Evolution con apikey y body number+text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ key: { id: 'msg-1' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendWhatsApp('hola');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://evo.test/message/sendText/kairos');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('evo-key');
    expect(JSON.parse(init.body)).toEqual({ number: '573001234567', text: 'hola' });
    expect(result.messageId).toBe('msg-1');
  });

  test('lanza cuando Evolution responde no-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(sendWhatsApp('x')).rejects.toThrow();
  });

  test('lanza cuando falta configuración de Evolution', async () => {
    vi.stubEnv('EVOLUTION_API_URL', '');
    await expect(sendWhatsApp('x')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npx vitest run src/notify/whatsapp.test.ts`
Expected: FALLA (no existe `./whatsapp.ts`).

- [ ] **Step 3: Crear `src/notify/whatsapp.ts`**

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export interface SendResult {
  messageId: string | null;
}

// Envío determinista por el REST de Evolution (lo usa el notificador por template).
export async function sendWhatsApp(text: string, to?: string): Promise<SendResult> {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  const number = to ?? process.env.WHATSAPP_CONTROL_NUMBER;
  if (!baseUrl || !apiKey || !instance || !number) {
    throw new Error('Configuración de Evolution incompleta (URL/KEY/INSTANCE/NUMBER)');
  }

  // Evolution API v2: POST /message/sendText/{instance}, header apikey, body { number, text }.
  const res = await fetch(`${baseUrl}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ number, text }),
  });
  if (!res.ok) {
    throw new Error(`Evolution respondió ${res.status}`);
  }

  const data = (await res.json()) as { key?: { id?: string } };
  return { messageId: data.key?.id ?? null };
}

// Tool de salida para el agente de control (Fase 2). No es una tool de mutación de dinero.
export const sendWhatsappTool = defineTool({
  name: 'send_whatsapp',
  description: 'Envía un mensaje de texto por WhatsApp al número de control vía Evolution API.',
  input: v.object({ text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) }),
  output: v.object({ messageId: v.nullable(v.string()) }),
  async run({ input }) {
    return await sendWhatsApp(input.text);
  },
});
```

- [ ] **Step 4: Ejecutar el test y verificar que pasa**

Run: `npx vitest run src/notify/whatsapp.test.ts`
Expected: PASA.

- [ ] **Step 5: Commit**

```bash
git add src/notify/whatsapp.ts src/notify/whatsapp.test.ts
git commit -m "feat: salida WhatsApp send_whatsapp por REST de Evolution"
```

---

### Task 7: Canal Evolution (ingreso WhatsApp custom, dirigido por blueprint)

Crea el canal de ingreso de WhatsApp. La lógica determinista (verificación de secreto, autorización del remitente, auditoría) es código concreto y testeado; el *binding* `channel` que Flue descubre se genera con el blueprint genérico porque el contrato del objeto de canal es interno de Flue (no hay primitiva pública). En Fase 0 el canal **verifica → autoriza → audita → 200**; el `dispatch` al agente de control llega en Fase 2.

> **Verificación obligatoria (CLAUDE.md / canal custom).** Antes de escribir el binding, obtener el blueprint oficial y seguirlo:
> ```bash
> npx flue add channel https://doc.evolution-api.com/ --print
> ```
> El blueprint guía: exportar un binding `channel` con nombre, verificar la petición contra el cuerpo sin consumir, y rutas bajo `/channels/evolution/<sufijo>`. Wirear ahí las funciones deterministas de abajo. Probar firma válida/ inválida, handshake y target Node (checklist del blueprint).
>
> El mecanismo de auth del webhook de Evolution depende de la versión. Aquí se usa un header de secreto compartido (`x-evolution-secret` vs `EVOLUTION_WEBHOOK_SECRET`) como contrato concreto y testeable; ajustarlo al esquema real de la instancia si difiere.

**Files:**
- Create: `src/channels/evolution.ts`
- Test: `src/channels/evolution.test.ts`

**Interfaces:**
- Produces (testeable): `verifyEvolutionWebhook(headers: Headers): boolean`, `extractSenderNumber(body: unknown): string | null`, `isAuthorizedSender(number: string | null): boolean`, y `handleEvolutionWebhook(headers: Headers, body: unknown): Promise<{ status: number }>` desde `src/channels/evolution.ts`.
- Produces (descubierto por Flue): export con nombre `channel` (binding generado vía blueprint, que delega en `handleEvolutionWebhook`).
- Consumes: `EVOLUTION_WEBHOOK_SECRET`, `WHATSAPP_CONTROL_NUMBER` del entorno; `appendAuditLog` de Task 4.

- [ ] **Step 1: Obtener el blueprint genérico de canal**

Run: `npx flue add channel https://doc.evolution-api.com/ --print`
Expected: imprime el markdown del blueprint genérico de canal (no instala ni escribe nada). Leerlo: define cómo construir el binding `channel` y la checklist de verificación.

- [ ] **Step 2: Escribir los tests de la lógica determinista (RED)**

`src/channels/evolution.test.ts`:
```ts
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { pool, query } from '../db/pool.ts';
import {
  verifyEvolutionWebhook,
  extractSenderNumber,
  isAuthorizedSender,
  handleEvolutionWebhook,
} from './evolution.ts';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  vi.stubEnv('EVOLUTION_WEBHOOK_SECRET', 'top-secret');
  vi.stubEnv('WHATSAPP_CONTROL_NUMBER', '573001234567');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const headers = (secret?: string) =>
  new Headers(secret ? { 'x-evolution-secret': secret } : {});

const inbound = (jid: string) => ({ data: { key: { remoteJid: jid } } });

describe('verifyEvolutionWebhook', () => {
  test('acepta el secreto correcto', () => {
    expect(verifyEvolutionWebhook(headers('top-secret'))).toBe(true);
  });
  test('rechaza secreto ausente o incorrecto', () => {
    expect(verifyEvolutionWebhook(headers())).toBe(false);
    expect(verifyEvolutionWebhook(headers('wrong'))).toBe(false);
  });
});

describe('extractSenderNumber / isAuthorizedSender', () => {
  test('extrae los dígitos del remoteJid', () => {
    expect(extractSenderNumber(inbound('573001234567@s.whatsapp.net'))).toBe('573001234567');
  });
  test('devuelve null si no hay remoteJid', () => {
    expect(extractSenderNumber({})).toBeNull();
  });
  test('solo autoriza el número de control', () => {
    expect(isAuthorizedSender('573001234567')).toBe(true);
    expect(isAuthorizedSender('999')).toBe(false);
    expect(isAuthorizedSender(null)).toBe(false);
  });
});

describe('handleEvolutionWebhook', () => {
  test('secreto inválido → 401 y no audita', async () => {
    const res = await handleEvolutionWebhook(headers('wrong'), inbound('573001234567@s.whatsapp.net'));
    expect(res.status).toBe(401);
  });

  test('válido + autorizado → 200 y registra en audit_log', async () => {
    const res = await handleEvolutionWebhook(
      headers('top-secret'),
      inbound('573001234567@s.whatsapp.net'),
    );
    expect(res.status).toBe(200);
    const rows = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM kairos.audit_log WHERE event_type = 'whatsapp.inbound'`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  test('válido pero remitente no autorizado → 200 sin acción', async () => {
    const res = await handleEvolutionWebhook(headers('top-secret'), inbound('999@s.whatsapp.net'));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Ejecutar los tests y verificar que fallan**

Run: `npx vitest run src/channels/evolution.test.ts`
Expected: FALLA (no existe `./evolution.ts`).

- [ ] **Step 4: Crear la lógica determinista en `src/channels/evolution.ts`**

```ts
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Verifica el secreto compartido del webhook (ajustar al esquema real de Evolution; ver nota del task).
export function verifyEvolutionWebhook(headers: Headers): boolean {
  const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
  const received = headers.get('x-evolution-secret');
  return Boolean(expected) && received === expected;
}

// Extrae el número del remitente desde el remoteJid del payload de Evolution.
export function extractSenderNumber(body: unknown): string | null {
  const jid = (body as { data?: { key?: { remoteJid?: string } } })?.data?.key?.remoteJid;
  if (typeof jid !== 'string') return null;
  const digits = jid.split('@')[0]?.replace(/\D/g, '');
  return digits ? digits : null;
}

// Solo el número de control autorizado puede operar el bot.
export function isAuthorizedSender(number: string | null): boolean {
  return number !== null && number === process.env.WHATSAPP_CONTROL_NUMBER;
}

// Lógica del webhook: verificar → autorizar → auditar → status. dispatch al control = Fase 2.
export async function handleEvolutionWebhook(
  headers: Headers,
  body: unknown,
): Promise<{ status: number }> {
  if (!verifyEvolutionWebhook(headers)) {
    return { status: 401 };
  }
  const sender = extractSenderNumber(body);
  if (!isAuthorizedSender(sender)) {
    // Entrega válida pero no autorizada: se ignora silenciosamente (200 para no reintentar).
    return { status: 200 };
  }
  await appendAuditLog({
    eventType: 'whatsapp.inbound',
    actor: sender ?? 'unknown',
    payload: { received: true },
  });
  return { status: 200 };
}
```

- [ ] **Step 5: Wirear el binding `channel` según el blueprint**

Añade al final de `src/channels/evolution.ts` el export con nombre `channel` siguiendo el binding del blueprint del Step 1, de modo que el handler de la ruta `POST /channels/evolution/webhook` llame a `handleEvolutionWebhook(c.req.raw.headers, await c.req.json())` y responda con ese `status` (cuerpo vacío). No inventar la forma del objeto `channel`: usar exactamente la del blueprint. Verificar con su checklist (firma válida → 200; inválida → 401; target Node).

Mantén el binding como un **adaptador delgado** (solo traduce la petición HTTP a `handleEvolutionWebhook` y devuelve el status): toda la lógica testeable vive en las funciones del Step 4, ya cubiertas. Si esas pocas líneas de glue HTTP bajan la cobertura del archivo por debajo del 80 %, añade **solo el binding** (no las funciones) a `coverage.exclude` en `vitest.config.ts` — es glue de I/O que ejercitan el smoke de build (Step 7) y, en producción, una petición real al webhook.

- [ ] **Step 6: Ejecutar los tests y verificar que pasan**

Run: `npx vitest run src/channels/evolution.test.ts`
Expected: PASA.

- [ ] **Step 7: Build con el canal descubierto**

Run: `npx flue build --target node`
Expected: build exitoso; Flue descubre `channels/evolution.ts` (publica `/channels/evolution/...`).

- [ ] **Step 8: Commit**

```bash
git add src/channels/evolution.ts src/channels/evolution.test.ts
git commit -m "feat: canal de ingreso WhatsApp de Evolution (verificación + auditoría)"
```

---

### Task 8: Gate de Fase 0 (smoke end-to-end + cierre)

Verifica que el andamiaje completo arranca y que ambos esquemas (Flue `flue_*` y dominio `kairos`) quedan provisionados. Cierra la fase.

**Files:**
- Modify: `Dockerfile` (crear) — `node:22.19-slim`, servicio long-running
- Modify: `README.md` (apuntar el flujo de arranque de Fase 0)
- Test: ejecución de toda la suite + cobertura

- [ ] **Step 1: Levantar dependencias y migrar el dominio**

Run:
```bash
docker compose up -d
npm run migrate
```
Expected: Postgres + Redis arriba; migración OK.

- [ ] **Step 2: Correr toda la suite con cobertura**

Run: `npx vitest run --coverage`
Expected: todos los tests PASAN; cobertura ≥ 80 % en líneas/funciones/ramas/sentencias.

- [ ] **Step 3: Type-check global**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 4: Build y arranque del server; verificar `/health` y tablas `flue_*`**

Run (en una terminal):
```bash
npm run build
set -a; source .env; set +a
node dist/server.mjs
```
En otra terminal:
```bash
curl -s localhost:3000/health
```
Expected: `/health` devuelve `{"status":"ok","mode":"sim"}`. (Puertos: producción `node dist/server.mjs` → `:3000`; `flue dev` → `:3583`. Hacer curl al puerto del modo en uso.) Al arrancar, el adapter de Flue creó las tablas `flue_*`. Verificar:
```bash
docker compose exec postgres psql -U user -d kairos -c "\dt flue_*"
docker compose exec postgres psql -U user -d kairos -c "\dt kairos.*"
```
Expected: existen tablas `flue_*` y las 15 tablas del esquema `kairos`. Detener el server (Ctrl+C).

- [ ] **Step 5: Crear el `Dockerfile` del servicio**

```dockerfile
# Servicio Node long-running de Kairos (Flue Node target). Node ≥ 22.19 (engines de Flue).
FROM node:22.19-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Fase 0: instala todas las deps (flue build necesita devDeps). Optimización futura: multi-stage + --omit=dev.
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
```

- [ ] **Step 6: Actualizar el `README.md` con el flujo de arranque de Fase 0**

Añadir una sección "Arranque local (Fase 0)" con: `docker compose up -d` → `npm install` → `npm run migrate` → `npm run dev` (`:3583`) o `npm run build && npm start` (`:3000`), y `npm test` para la suite. Incluir la **nota de migración en producción**: el contenedor (`Dockerfile`) **no** corre `migrate` al arrancar — el esquema `kairos` debe migrarse con `npm run migrate` (o un init-container/entrypoint) antes del primer boot; Flue migra sus `flue_*` automáticamente. Mantener el resto del README intacto (cambio quirúrgico).

- [ ] **Step 7: Commit de cierre de fase**

```bash
git add Dockerfile README.md
git commit -m "chore: Dockerfile del servicio y flujo de arranque de Fase 0"
```

---

## Verificación de cierre de Fase 0 (criterios de éxito)

- [ ] `flue build --target node` produce `dist/server.mjs` y `node dist/server.mjs` arranca.
- [ ] `GET /health` → `{ status: 'ok', mode: 'sim' }`.
- [ ] Postgres tiene tablas `flue_*` (Flue) y las 15 tablas del esquema `kairos` (dominio).
- [ ] `orders.idempotency_key` tiene restricción `UNIQUE`.
- [ ] Dos clientes ccxt: público sin clave; autenticado con credencial en closure y sandbox salvo `live`.
- [ ] `send_whatsapp` postea al REST de Evolution; canal de ingreso verifica secreto, autoriza al número de control y audita.
- [ ] `npm test` verde con cobertura ≥ 80 %; `npm run typecheck` sin errores.
- [ ] Cero LLM, cero tools de mutación, cero dinero tocado: pura infraestructura.

## Fuera de alcance de esta fase (entra en Fase 1+)

Scanner, rules-engine, indicadores (`technicalindicators`), `check_risk`, `execute_order`/`paper-sim`, monitor de salida, reconciler, scheduler BullMQ (Redis), ingester de market-data (WS/REST), backtester. Agentes/LLM, skills de doctrina y `dispatch` del canal de control entran en Fase 2. (Ver `ARCHITECTURE.md` §13.)
