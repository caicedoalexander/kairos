# Task 2 Report (SP1): Repositorio de OHLCV

## Qué se implementó

Se completó la Task 2 del andamiaje de Kairos en la rama `feat/fase-0-andamiaje`.

### Archivos creados

| Archivo | Rol |
|---------|-----|
| `src/db/pool.ts` | Pool `pg` compartido + helper `query<T>()` |
| `src/db.ts` | Store de Flue (BYO-driver), default export `PersistenceAdapter` |
| `src/db/pool.test.ts` | Test de integración: `SELECT 1` contra Postgres real |

### Pasos ejecutados

1. `npm view @flue/postgres version` → confirmó `1.0.0-beta.3` disponible.
2. `npx flue add database postgres --print` → blueprint confirmó patrón BYO-driver con `{ query, transaction, close }`.
3. `npm install @flue/postgres pg` + `npm install -D @types/pg` → instalados sin conflictos.
4. `docker compose up -d postgres` → contenedor postgres:16 levantado en `:5432`.
5. Creado `src/db/pool.test.ts` con `SELECT 1 AS one` (test RED).
6. Ejecutado test → FALLÓ por módulo inexistente (RED confirmado).
7. Creado `src/db/pool.ts` con Pool + helper `query<T>`.
8. Creado `src/db.ts` con `postgres({ query, transaction, close })` compartiendo el pool.
9. Ejecutado test → PASÓ (GREEN).
10. `npm run typecheck` → sin errores.
11. Commit `561ad19`.

## Evidencia TDD RED → GREEN

```
# RED (Step 4)
FAIL  src/db/pool.test.ts
Error: Cannot find module './pool.ts'

# GREEN (Step 7)
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  599ms
```

## Resultados de tests

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  10:59:32
   Duration  599ms (transform 94ms, setup 45ms, import 241ms, tests 81ms)
```

## Resultado de typecheck

```
> tsc --noEmit
(sin salida — sin errores)
```

## Self-review

- `src/db/pool.ts`: lanza `Error` al arranque si falta `DATABASE_URL` (validación en límite). Pool sin config extra = defaults de `pg` (max 10 conexiones). Helper `query<T>` tipado genérico, <20 líneas.
- `src/db.ts`: usa BYO-driver exactamente como el blueprint de Flue. `transaction` checkea un solo client, hace `BEGIN/COMMIT/ROLLBACK`, libera con `finally`. <30 líneas.
- Los repositorios de dominio (Tasks 3–4) pueden importar `{ pool, query }` desde `src/db/pool.ts` sin duplicar conexiones.
- Sin `console.log`, sin secretos hardcodeados, sin abstracciones innecesarias.

## Concerns

Ninguno crítico. Observaciones menores:

1. **Cobertura**: solo 1 test (`SELECT 1`). El brief no pedía más para esta task, y el threshold de 80% de vitest.config.ts aplica al proyecto completo — con una sola línea de lógica real en pool.ts y el flujo feliz cubierto, es suficiente para la fase de andamiaje.
2. **Pool sin límite explícito**: `max` de `pg.Pool` por defecto es 10 conexiones. Para la Fase 0 (sim, sin carga) es más que suficiente; cuando se escale se puede parametrizar con `POOL_MAX`.
3. **`@flue/postgres` versión beta.3 vs runtime beta.5**: versiones distintas de paquetes separados, comportamiento esperado según el brief.

---

## Fix MEDIUM — tipado explícito de `params` en `query<T>` (hallazgo de revisión)

### Hallazgo

El helper `query<T>` declaraba `params?: unknown[]` y usaba `params as never` para silenciar a TypeScript. Esto (a) dejaba pasar parámetros inválidos a los repositorios de dominio y (b) introducía un cast defensivo innecesario.

### Cambio aplicado (`src/db/pool.ts`)

```diff
+export type QueryParam = string | number | boolean | null | Date;
+
 export async function query<T = Record<string, unknown>>(
   text: string,
-  params?: unknown[],
+  params?: QueryParam[],
 ): Promise<T[]> {
-  const result = await pool.query(text, params as never);
+  const result = await pool.query(text, params ?? []);
   return result.rows as T[];
 }
```

- Se exporta `QueryParam` para que los repositorios (Tasks 3–4) puedan anotarlo.
- `params ?? []` en lugar de `params as never`: `pool.query` acepta `QueryConfigValues<I>` (un array) — pasar `[]` cuando `params` es `undefined` es correcto y elimina el cast.
- Sin `as never`, sin `as any`, sin nuevas dependencias.

### Verificación

```
$ npm run typecheck
> tsc --noEmit
(sin salida — sin errores)

$ npx vitest run src/db/pool.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  767ms
```

---

# Task 2 Report (SP1 market-data): Repositorio de OHLCV

## Qué se implementó

- `src/db/repositories/ohlcv-candles.ts` — repositorio con tres funciones exportadas:
  - `upsertCandles(rows)` — upsert idempotente en chunks de 500 filas; retorna nº de filas realmente insertadas.
  - `getLatestOpenTime(symbol, timeframe)` — `SELECT max(open_time)`, retorna `Date | null`.
  - `getCandles(symbol, timeframe, from, to)` — rango ascendente; convierte columnas `numeric` de pg a `number`.
- `src/db/repositories/ohlcv-candles.test.ts` — 7 tests de integración contra Postgres real.

## Evidencia TDD RED → GREEN

### RED (Step 2)

```
npx vitest run src/db/repositories/ohlcv-candles.test.ts

 FAIL  src/db/repositories/ohlcv-candles.test.ts
Error: Cannot find module './ohlcv-candles.ts'

 Test Files  1 failed (1)
      Tests  no tests
   Duration  418ms
```

### GREEN (Step 4)

```
npx vitest run src/db/repositories/ohlcv-candles.test.ts

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Duration  610ms
```

### Typecheck

```
npm run typecheck
> tsc --noEmit
(sin salida — sin errores)
```

## Archivos cambiados

| Archivo | Acción |
|---|---|
| `src/db/repositories/ohlcv-candles.ts` | creado |
| `src/db/repositories/ohlcv-candles.test.ts` | creado |

## Auto-revisión

- Implementación verbatim del brief (sin añadir nada extra — YAGNI).
- Imports con extensión `.ts` (ESM). Comentarios en español.
- Sin `console.log`, sin secretos hardcodeados, sin mutación.
- Idempotencia garantizada por `ON CONFLICT DO NOTHING` + `RETURNING 1`.
- Chunking en `upsertCandles` evita superar el límite de 65 535 params de pg.

## Concerns

Ninguno.

---

# Task 2 Report (SP2 scanner): Detector de estructura (swings → soporte/resistencia)

## Qué se implementó

Se completó la Task 2 del scanner en la rama `feat/fase-1-sp2-scanner`.

### Archivos creados

| Archivo | Rol |
|---------|-----|
| `src/lib/scanner/structure.ts` | Implementación de `computeStructure`, `nearestBelow`, `nearestAbove` |
| `src/lib/scanner/structure.test.ts` | Suite de tests (3 tests) |

### Pasos ejecutados

1. Escribir `src/lib/scanner/structure.test.ts` verbatim del brief (RED).
2. Ejecutar test → FALLÓ — módulo inexistente (RED confirmado).
3. Crear `src/lib/scanner/structure.ts` con las tres funciones exportadas.
4. Ejecutar test → PASÓ (GREEN).
5. `npm run typecheck` → sin errores.
6. Commit `b96765f`.

## Evidencia TDD RED → GREEN

### RED (Step 2)

```
npx vitest run src/lib/scanner/structure.test.ts

 FAIL  src/lib/scanner/structure.test.ts
Error: Cannot find module './structure.ts'

 Test Files  1 failed (1)
      Tests  no tests
   Duration  409ms
```

### GREEN (Step 4)

```
npx vitest run src/lib/scanner/structure.test.ts

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  392ms
```

### Typecheck

```
npm run typecheck
> tsc --noEmit
(sin salida — sin errores)
```

## Detalles de implementación

### `computeStructure(candles, lookback = 5)`

Detecta swings (picos y valles) por pivotes:
- Itera sobre índices `i ∈ [lookback, length - lookback)`.
- Para cada `i`, extrae ventana `[i-lb, i+lb]` de tamaño `2*lb + 1`.
- Si `candles[i].h` es el máximo de la ventana → swing high → añade a `resistances`.
- Si `candles[i].l` es el mínimo de la ventana → swing low → añade a `supports`.
- Los últimos `lookback` velas no se confirman (sin ventana derecha).

### `nearestBelow(price, levels)`

Retorna el máximo nivel ≤ precio, o null si no existe.

### `nearestAbove(price, levels)`

Retorna el mínimo nivel ≥ precio, o null si no existe.

## Resultados de tests

```
✓ computeStructure › detecta un swing high y un swing low aislados
  (índice 3 con h=20 detectado como resistencia, índice 7 con l=1 como soporte)

✓ nearestBelow / nearestAbove › nearestBelow devuelve el mayor nivel ≤ precio o null
  (100, [90, 95, 110]) → 95
  (80, [90, 95]) → null

✓ nearestBelow / nearestAbove › nearestAbove devuelve el menor nivel ≥ precio o null
  (100, [90, 110, 120]) → 110
  (130, [90, 110]) → null

3 tests passed
```

## Archivos cambiados

```
 src/lib/scanner/structure.ts       | 28 ++++++++++++++++++++++++++++
 src/lib/scanner/structure.test.ts  | 28 ++++++++++++++++++++++++++++
 2 files changed, 56 insertions(+)
```

## Auto-revisión

- ✓ Implementación verbatim del brief.
- ✓ Imports con extensión `.ts` (ESM). Comentarios en español.
- ✓ Tipo `Candle` importado de `./types.ts`.
- ✓ Funciones puras, sin estado, sin side effects.
- ✓ <50 líneas por función, sin abstracciones especulativas.
- ✓ Sin `any`, tipos explícitos en funciones exportadas.
- ✓ Sin mutaciones, arrays nuevos retornados.
- ✓ Sin `console.log`, sin secretos hardcodeados.
- ✓ Tests 100% cobertura de los 3 casos.
- ✓ Verificado con `npm run typecheck` (sin errores).

## Concerns

Ninguno.
