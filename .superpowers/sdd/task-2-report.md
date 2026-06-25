# Task 2 Report: Store de Flue en Postgres (`db.ts` + pool compartido)

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
