# SP6 — Cierre de Fase 1 en `sim`: salida + dedup + shutdown + reconciler delgado

**Fecha:** 2026-06-28
**Estado:** diseño aprobado, listo para plan de implementación.

## Meta

Cerrar el loop determinista de Fase 1. Las posiciones que **entra** SP5 ahora:

1. **Salen** por SL/TP en vivo (monitor de salida), no se quedan abiertas para siempre.
2. No se **apilan** por setup (dedup per-setup) — el bloqueador conocido antes de testnet.
3. El proceso **arranca y para limpio** (graceful shutdown + reconciler de arranque).

Todo en `sim`, sin LLM, determinista e idempotente. Esto permite medir el *edge mecánico* del
loop completo en vivo (entrada→salida) antes de gastar en modelos o tocar dinero real.

## Alcance y decisiones de diseño

### Fuera de alcance (decisiones tomadas en brainstorming)

- **Reconciler completo contra exchange (ccxt):** diferido al sprint de testnet. En `sim` no hay
  exchange real que reconciliar — las posiciones viven solo en DB. En SP6 el reconciler es solo un
  **pase de auto-consistencia de DB** (audita estados huérfanos). Construir el `fetch` de ccxt ahora
  es YAGNI; su valor real es de testnet/live.
- **Cooldown post-cierre:** no se implementa. El dedup es un **guard duro sin cooldown**: apenas la
  posición cierra (SL/TP), el setup puede volver a disparar. Si el churn post-stop aparece en datos
  de `sim`, se añade después (medible, no especulativo).
- **Shorts / dirección en la clave de dedup:** Fase 1 es long-only (shorts fuera de alcance), así
  que la dirección no agrega nada a `setup_key`.

### Invariantes que se preservan (líneas rojas, CLAUDE.md)

- El cierre por SL/TP es **determinista e inmediato** — nunca espera a un LLM.
- Toda mutación que toca dinero es idempotente; el monitor cierra con `UPDATE … WHERE status='open'`.
- La notificación es **best-effort**: un fallo de `notify` nunca tumba el cierre ya ejecutado
  (mismo patrón `notifyBestEffort` de SP5).
- Modo (`sim|testnet|live`) explícito y persistido; el dedup y la exposición se aíslan por `mode`.

## Componentes

### 1. Monitor de salida (`monitor-tick`)

**Mecanismo:** job repetible BullMQ propio (`monitor-tick`), en el mismo scheduler que el scan
pero con **cadencia propia** (`MONITOR_INTERVAL_MS`). Separado del scan-tick para que la cadencia de
salida sea independiente de la de entrada (los exits deben chequearse al menos tan seguido como las
entradas). Alternativa descartada: plegar el exit dentro del scan-tick (un solo scheduler, pero
acopla cadencias y mezcla responsabilidades).

**Por tick:**

1. `getOpenPositions(mode)` — todas las posiciones `open` del modo activo.
2. Por cada posición: leer la **última vela cerrada del trigger-TF** de su estrategia (misma fuente
   que el scanner — cero infra nueva), **acotada a velas que abrieron después de `opened_at`** de la
   posición. Esto evita resolver el bracket en la misma vela de entrada (look-ahead / double-count),
   respetando la convención del backtester (§20: resolver desde la vela siguiente). Exige exponer
   `opened_at` en `getOpenPositions`.
3. `resolveBracket(position, bar, simParams)` (reusa la lógica del backtester, `bracket.ts`):
   - `null` (no toca SL ni TP): nada.
   - Toca SL/TP: en **una transacción** →
     - `closePosition(id, realizedPnl, closedAt)` (UPDATE … WHERE status='open').
     - Marcar las legs OCO (`sl`/`tp`) de la orden de entrada como cerradas.
     - `appendAuditLog({ eventType: 'position_closed_sim', … })`.
     - `notifyBestEffort(...)` con el detalle del cierre (precio de salida, P&L, hitType).

**Idempotencia:** el cierre solo aplica si la posición sigue `open` (`rowCount=0` → ya cerrada →
skip silencioso). Re-evaluar la misma vela en ticks sucesivos es seguro porque `resolveBracket` es
determinista y el `UPDATE` condicional no re-cierra.

**Dato faltante — `entryFee`:** `resolveBracket` necesita `position.entryFee` y hoy `positions` no
lo guarda (vive en `fills`). **Decisión:** añadir columna `entry_fee numeric` a `positions` y
setearla en `openPosition` (el `execute-order` ya tiene `fill.fee` a mano). Evita un join a `fills`
por posición por tick. Alternativa descartada: join al cargar la posición.

### 2. Dedup per-setup

`setup_key = (strategy_id, symbol, mode)`. Una sola posición viva por setup.

**Capa 1 — índice único parcial en DB (red race-safe):**

```sql
CREATE UNIQUE INDEX idx_positions_open_setup
  ON kairos.positions (strategy_id, symbol, mode)
  WHERE status = 'open';
```

Garantiza la invariante a nivel DB, igual que `UNIQUE(idempotency_key)`. Si dos señales del mismo
setup corren a la vez (cada una con su `signalId`, así que el dedup de cola por `jobId` no las
detiene), el segundo `INSERT` de `openPosition` viola el índice.

**Capa 2 — manejo en `executeOrderSim`:** dentro de la transacción, una violación de ese índice
(error `23505` sobre `idx_positions_open_setup`) se captura y se devuelve como
**`ExecutionResult.status = 'deduped'`** (status nuevo), no como crash. Distinto de `'duplicate'`
(que es por `idempotency_key = signalId`, la misma señal reintentada).

**Capa 3 — pre-check barato en `evaluateCandidate`:** antes de `persistDecision`/`execute`,
`hasOpenPositionForSetup(strategyId, symbol, mode)` → si hay posición viva, retorna
`{ kind: 'skipped', reason: 'dedup: posición abierta para el setup' }`. Evita el trabajo y el ruido
de unique-violation en el caso común. El índice (capa 1) es la red ante carreras que el pre-check no
puede cerrar.

**Nota:** el pre-check en `scan-tick` (early-out antes de `enqueue`) queda como nice-to-have
opcional, no en el camino crítico. El authoritative es `evaluateCandidate` + el índice.

### 3. Graceful shutdown

En `worker.ts`, handler de `SIGTERM`/`SIGINT` (idempotente vía flag para no entrar dos veces):

1. `await scanWorker.close()`, `await evaluateWorker.close()`, `await monitorWorker.close()` —
   `Worker.close()` de BullMQ deja terminar el job en vuelo y deja de tomar nuevos.
2. `await scanQueue.close()` (y demás queues).
3. `closeBullConnection()`.
4. `pool.end()`.
5. Timeout de gracia (`SHUTDOWN_TIMEOUT_MS`) que fuerza `process.exit(1)` si algo cuelga.

Resuelve la regla de Flue de que Node no auto-termina runs interrumpidos: al parar limpio, no quedan
workers tomando jobs ni conexiones colgadas.

### 4. Reconciler delgado (auto-consistencia de DB, sin ccxt)

Pase de **arranque** en `worker.ts`, **antes** de programar el scheduler del scan (recién después
arranca el loop, según §5 del ARCHITECTURE). Solo **audita** (aislado por `mode`), no corrige nada
que mueva dinero:

- Órdenes de **entrada `pending` sin fill** (ejecución a medias / crash) →
  `appendAuditLog({ eventType: 'reconcile_stuck_order', … })`.
- **Legs OCO `pending` de posiciones ya cerradas** (huérfanas) →
  `appendAuditLog({ eventType: 'reconcile_orphaned_leg', … })`.

**No** se detecta "señal `fired` sin decisión" como huérfana: las señales *skipped* y *deduped*
tampoco persisten decisión, así que serían indistinguibles de una huérfana real sin rastrear el
ciclo de vida de la señal (`signals.status`) — scope creep que se difiere.

En `sim` no toca exchange. El diff exchange↔DB (corrección de desviaciones reales) es del sprint de
testnet, donde `mode` aísla las posiciones a reconciliar.

## Interfaces nuevas (resumen)

- `positions.ts`:
  - `getOpenPositions(mode, exec?): Promise<OpenPosition[]>` — incluye `entryFee`, `decisionId`, `triggerTimeframe` y `openedAt`.
  - `hasOpenPositionForSetup(strategyId, symbol, mode, exec?): Promise<boolean>`.
  - `closeOpenPosition(id, realizedPnl, closedAt, exec?): Promise<boolean>` (idempotente, `WHERE status='open'`).
  - `openPosition(...)` extendido para persistir `entry_fee` y `decision_id`.
- `execute-order.ts`: `ExecutionResult.status` gana `'deduped'`; captura de violación del índice.
- `evaluate-candidate.ts`: pre-check de dedup → `{ kind: 'skipped', reason }`.
- `lib/monitor/monitor-tick.ts` (nuevo): `runMonitorTick(asOf, deps?)` con deps inyectables
  (mismo patrón que `scan-tick.ts`).
- `worker.ts`: `monitorWorker` + `monitor-tick` scheduler + shutdown + reconciler de arranque.
- Migración: columnas `entry_fee` y `decision_id` + índice único parcial `idx_positions_open_setup`.

## Orden de tareas (TDD, subagent-driven)

1. **Esquema:** migración del índice único parcial + columna `entry_fee` (con tests de migración).
2. **`positions.ts`:** `getOpenPositions`, `entry_fee` en `openPosition`, `hasOpenPositionForSetup`.
3. **Dedup:** `executeOrderSim` (status `deduped` ante violación del índice) + pre-check en
   `evaluateCandidate` (status `skipped`) + tests (incluye carrera de dos señales del mismo setup).
4. **Monitor de salida:** `lib/monitor/monitor-tick.ts` + cierre-por-bracket (tx) + tests
   (SL, TP, no-touch, idempotente, notify best-effort).
5. **Wiring del monitor** en `worker.ts` (`monitorWorker` + scheduler `monitor-tick`).
6. **Graceful shutdown** en `worker.ts` + test del handler.
7. **Reconciler delgado** + wiring de arranque + tests.

## Criterios de éxito

- Una posición `open` cuya última vela toca el SL se cierra con `realized_pnl` correcto, las legs
  OCO quedan cerradas, hay audit `position_closed_sim` y se intentó notificar.
- Dos señales del mismo `(strategy, symbol, mode)` con una posición ya abierta no crean una segunda
  posición (ni por pre-check ni por carrera — el índice lo garantiza).
- `SIGTERM` al worker termina los jobs en vuelo y cierra conexiones sin dejar jobs `active`.
- El reconciler de arranque audita estados huérfanos antes de que el scanner dispare.
- `npm test` y `npm run typecheck` en verde; cobertura ≥ 80%.
