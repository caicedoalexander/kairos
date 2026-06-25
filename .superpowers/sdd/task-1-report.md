# Task 1 Report — Bootstrap del proyecto Flue (Node target)

## Status: DONE_WITH_CONCERNS

## Qué se implementó

Todos los pasos del brief completados. El gate (test verde + `dist/server.mjs`) está en pie.

### Archivos creados/modificados
| Archivo | Acción |
|---|---|
| `package.json` | Modificado: `type`, `engines`, `scripts`, deps base fusionados |
| `package-lock.json` | Modificado: lockfile actualizado |
| `flue.config.ts` | Creado: `defineConfig({ target: 'node' })` |
| `tsconfig.json` | Creado: ES2022, moduleResolution bundler, noEmit, allowImportingTsExtensions |
| `vitest.config.ts` | Creado: provider v8, umbrales 80%, setupFiles |
| `vitest.setup.ts` | Creado: `import 'dotenv/config'` |
| `docker-compose.yml` | Creado: postgres:16 + redis:7 noeviction |
| `src/lib/mode.ts` | Creado: `TradingMode` + `getMode()` con validación y default `sim` |
| `src/health.ts` | Creado: Hono app con `GET /health → { status, mode }` |
| `src/app.ts` | Creado: composición `health` + `flue()` en raíz |
| `src/health.test.ts` | Creado: test TDD del endpoint `/health` |
| `src/workflows/evaluate-candidate.ts` | Creado: stub mínimo (ver concerns) |

## Evidencia TDD RED → GREEN

**RED (Step 10):** `npx vitest run src/health.test.ts` falló con:
```
Error: Cannot find module './health.ts' imported from .../src/health.test.ts
```

**GREEN (Step 14):** Tras crear `src/lib/mode.ts` y `src/health.ts`:
```
Test Files  1 passed (1)
Tests  1 passed (1)
Duration  507ms
```

**Suite completa (pre-commit):**
```
Test Files  1 passed (1)
Tests  1 passed (1)
Duration  395ms
```

## Resultados de tests

- 1 archivo de test, 1 test, todos verdes.
- Cobertura: no se midió con `--coverage` en esta iteración (solo se corre `vitest run` sin flag). Los umbrales del 80% se aplican cuando se invoca con `--coverage`.

## Build gate

```
flue build --target node
  workflows: evaluate-candidate
done  built dist/server.mjs
done  ready dist
```

`dist/server.mjs` existe. Gate cumplido.

## Desviación del brief: workflow placeholder

El brief no menciona crear `src/workflows/evaluate-candidate.ts`. Sin embargo, `flue build` falló con:
```
Error: Build failed: [flue] No agent or workflow files found.
Expected at: src/agents/ or src/workflows/
```

La documentación de Flue (`project-layout.md`) confirma que el build requiere al menos un agente o workflow. Se creó el stub del workflow central del diseño (`evaluate-candidate`) con un `run()` que retorna inmediatamente sin tocar LLM ni dinero. El stub no tiene `route` ni `runs` exports, así que no es invocable por HTTP. Es el mínimo para que `flue build` pase y está alineado con el diseño (`workflows/evaluate-candidate.ts` es el flujo central de CLAUDE.md).

## Self-review

- Sin secretos hardcodeados. `.env` no se commitea (ya en `.gitignore`).
- `getMode()` valida en el límite del sistema; lanza con mensaje claro si `KAIROS_MODE` es inválido.
- Funciones < 50 líneas, archivos < 800 líneas.
- Sin `console.log` de debug.
- Inmutabilidad por defecto en todos los módulos.
- API de Flue verificada contra `node_modules/@flue/runtime/docs/` antes de usar: `flue()` de `@flue/runtime/routing`, `defineWorkflow`/`defineAgent` de `@flue/runtime`, `defineConfig` de `@flue/cli/config`.

## Concerns

1. **Workflow stub adelantado**: `evaluate-candidate.ts` es un stub que se requirió para que el build pase. El brief no lo especificaba. Está alineado con el diseño pero podría causar confusión de scope con Tasks futuras. Se recomienda documentarlo en el brief de Task 5 como "stub ya existe, reemplazar".

2. **Versiones de deps más nuevas que el brief**: Las versiones instaladas (`hono@4.12.27`, `valibot@1.4.1`, `@types/node@26.0.1`, `vitest@4.1.9`, `dotenv@17.4.2`, `typescript@6.0.3`) son más recientes que las del brief (`hono@4.8.3`, `valibot@1.1.0`, `@types/node@22.0.0`, `vitest@4.0.0`, `dotenv@16.0.0`). Se conservaron las versiones que npm resolvió (más recientes). No hay incompatibilidades observadas, pero Tasks futuras deberían validar contra estas versiones reales.

3. **Cobertura no medida con threshold**: Los umbrales de cobertura 80% están configurados en `vitest.config.ts` pero no se validaron con `--coverage` porque solo hay 1 test y el brief no lo requería en esta Task. Se medirá en Tasks posteriores al agregar más módulos.

## Commit

SHA: `b44d17d`
Subject: `chore: andamiaje del proyecto Flue (config, health, tooling de tests)`

---

## Fix H-1 y Fix M-1 — Correcciones post-revisión

### Fix H-1 — `@types/node` alineado con el piso de soporte

**Cambios en `package.json`:**
- `devDependencies."@types/node"`: `^26.0.1` → `^22.0.0`
- Añadidos `"name": "kairos"`, `"version": "0.0.0"` y `"private": true` (campos faltantes, suprimen warnings de npm)

**`npm install`** reconcilió el lockfile: instaló `@types/node@22.20.0` (línea 22.x, superset de 22.19.0).

**`npm run typecheck`** pasó sin errores con `@types/node@22`.

### Fix M-1 — Tests para ramas de `getMode()`

**Archivo creado:** `src/lib/mode.test.ts`

Cubre las tres ramas de `src/lib/mode.ts`:
1. `KAIROS_MODE` no definido → retorna `'sim'` (rama del default `?? 'sim'`)
2. `KAIROS_MODE` ∈ `['sim', 'testnet', 'live']` → retorna el valor (rama del path feliz)
3. `KAIROS_MODE` inválido → lanza `'KAIROS_MODE inválido'` (rama del throw)

Usa `vi.stubEnv`/`vi.unstubAllEnvs` sin mutar `process.env` directamente.

### Comandos ejecutados y resultados

**`npm run typecheck`**
```
> kairos@0.0.0 typecheck
> tsc --noEmit
(sin errores)
```

**`npx vitest run src/lib/mode.test.ts src/health.test.ts`**
```
 Test Files  2 passed (2)
      Tests  4 passed (4)
   Duration  503ms
```

**`npx vitest run --coverage`**
```
 Test Files  2 passed (2)
      Tests  4 passed (4)

 % Coverage report from v8
------------|---------|----------|---------|---------|-------------------
File        | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
------------|---------|----------|---------|---------|-------------------
------------|---------|----------|---------|---------|-------------------

Statements   : 100% ( 8/8 )
Branches     : 100% ( 4/4 )
Functions    : 100% ( 2/2 )
Lines        : 100% ( 7/7 )
```

`src/lib/mode.ts` queda con **100% de cobertura de ramas**. Cobertura global 100% (por encima del umbral 80%).
