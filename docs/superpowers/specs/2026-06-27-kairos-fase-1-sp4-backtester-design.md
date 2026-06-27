# SP4 — Backtester (replay reproducible, anti look-ahead, métricas)

> Fase 1 de Kairos, sub-proyecto 4. Fuente de verdad del diseño: `ARCHITECTURE.md` §20
> (y §16 scanner, §18 paper-sim, §19 riesgo). Este spec **acota** §20 a lo que SP4 construye;
> cualquier desviación respecto a §20 se justifica aquí, no en silencio.

## 1. Contexto y estado

SP1 (market-data), SP2 (scanner) y SP3 (riesgo + ejecución sim) están mergeados a `main`. SP3
dejó, **como funciones puras y deterministas**, todas las piezas de decisión y simulación que el
backtester orquesta:

| Pieza | Firma | Módulo | Pureza |
|---|---|---|---|
| Scanner | `scan(strategy, symbol, candlesByTf, deriv, now) → Signal \| null` | `src/lib/scanner/scan.ts` | pura (sin DB) |
| Veredicto determinista | `buildDeterministicVerdict(signal, strategy) → Verdict` | `src/lib/execution/verdict.ts` | pura |
| Risk gate (núcleo) | `evaluateRisk(RiskInput) → RiskResult` | `src/lib/execution/check-risk.ts` | pura (estado **inyectado**) |
| Sizing | `computeSize(equity, verdict, riskParams) → SizeBreakdown` | `src/lib/execution/sizing.ts` | pura |
| Fill paper-sim | `simulateFill(side, size, referencePrice, simParams) → FillResult` | `src/lib/execution/fill.ts` | pura |
| Resolución de salida OCO | `resolveBracket(position, bar, simParams) → BracketResolution \| null` | `src/lib/execution/bracket.ts` | pura |

Lectura de histórico (SP1): `getCandles(symbol, timeframe, from, to) → OhlcvRow[]` (orden `open_time`
ASC, `o/h/l/c/v` ya como `number`), `getStrategy(id) → Strategy \| null` (incluye `version`).

**SP4 es esencialmente un driver de replay que ensambla esas funciones puras barra a barra**, lleva
la contabilidad en memoria, calcula métricas (§20.3) y persiste `backtest_runs`. No introduce
ninguna pieza de decisión nueva: el "cerebro" es idéntico al de live (mismo code path de §16/§18/§19).

## 2. Decisiones de acotación (aprobadas)

| # | Decisión | Elección | Motivo |
|---|---|---|---|
| 1 | Contabilidad | **En memoria** reusando las funciones puras | Rápido, reproducible, no contamina `positions/orders/fills`. Reusa el código de **decisión**; el *sink* de persistencia (memoria vs repos) no afecta el edge. |
| 2 | Universo | **Single-símbolo iterado** | Suficiente para medir win-rate/payoff/expectancy (inputs de Kelly §19). El CLI puede iterar varios símbolos independientes y agregar. |
| 3 | Walk-forward / OOS | **Diferido** | Ventana única con point-in-time estricto valida el edge inicial. `backtest_runs.window` deja walk-forward como iteración trivial futura. |
| 4 | Entrypoint | **Función `runBacktest` + CLI delgado** | Sin dashboard (fuera de alcance). |

Sub-decisiones (ratificadas en la revisión del diseño):

- **(a)** Una posición a la vez por símbolo (no piramidar): mientras haya posición abierta no se
  evalúan entradas nuevas; solo se monitorea la salida. Mantiene `max_open_positions` trivial y la
  contabilidad simple.
- **(b)** No se persiste la equity curve barra-a-barra en Postgres (puede ser enorme); solo
  métricas + lista de trades en `backtest_runs`. La curva se imprime/vuelca por CLI.
- **(c)** Deuda `getDailyRealizedPnl` (timezone, §deuda-menor-fase1) se **reclasifica a SP5**: el
  backtester no usa esa query (computa el `dailyPnl` sobre el `T` simulado, no `now()`), así que SP4
  no la toca; queda anotada para el loop vivo.

### Fuera de alcance (diferido, YAGNI)

Multi-símbolo / cartera con equity compartida · walk-forward / out-of-sample · LLM-in-the-loop
(§20.1, Fase 2) · robustez estadística: Monte Carlo sobre orden de trades, bootstrap CIs, deflated
Sharpe (§20.3 ya lo marca como upgrade) · dashboard · `liquidations` como feature (§8 aún no lo
persiste con `ts` as-of).

## 3. Arquitectura — componentes nuevos (`src/lib/backtest/`)

Cada unidad tiene un propósito único y una interfaz explícita; las de cálculo son puras y testeables
en aislamiento.

### 3.1 `data-source.ts` — guardián del point-in-time

Carga el histórico de la ventana una vez (vía `getCandles` por cada TF de la estrategia) y entrega,
para cada paso `T`, **solo velas cerradas con `cierre ≤ T`**.

```ts
// Una vela [open_time, open_time + tfMs) está CERRADA en T sii  open_time + tfMs <= T.
export interface BacktestDataSource {
  triggerCandles: readonly Candle[];           // velas de la TF trigger en la ventana (orden ASC)
  // candlesByTf en el instante de cierre de la vela trigger de índice i (T = cierre de esa vela):
  closedCandlesAt(triggerIndex: number): CandlesByTimeframe;
  derivativesAt(T: Date): DerivativesContext;  // funding/OI con ts <= T; {null,null} si la estrategia no los usa
}
export async function loadDataSource(strategy: Strategy, symbol: string, window: Window): Promise<BacktestDataSource>;
```

El cierre de la vela trigger de índice `i` define `T_i = triggerCandles[i].openTime + tfMs(trigger)`.
`closedCandlesAt(i)` devuelve, por cada TF (`bias`/`context`/`trigger`), el prefijo de velas cuyo
cierre `≤ T_i`. La duración de cada TF se deriva del nombre (`5m`/`15m`/`1h`/…) con una tabla de
milisegundos (reusar el helper de TF de SP2 si existe; si no, uno local).

### 3.2 `accounting.ts` — contabilidad en memoria (espejo de los repos de `positions`)

Replica la semántica de `getExposure` / `getConsecutiveLosses` / `getDailyRealizedPnl` para producir
**el mismo `GatheredState` que `evaluateRisk` consume en vivo** — solo cambia la fuente (memoria vs
DB). Inmutable: cada operación devuelve un nuevo estado.

```ts
export interface OpenPosition { entry: number; size: number; sl: number; tp: number; entryFee: number; openedAt: Date; }
export interface ClosedTrade {
  openedAt: Date; closedAt: Date; entry: number; exit: number; size: number;
  fees: number; realizedPnl: number; hitType: 'sl' | 'tp' | 'eod'; rMultiple: number;
}
export interface Ledger {
  startingEquity: number; realized: number; peakEquity: number;
  open: OpenPosition | null; trades: readonly ClosedTrade[];
}
export function emptyLedger(startingEquity: number): Ledger;
export function gatherState(ledger: Ledger, T: Date, markPrice: number): GatheredState; // para evaluateRisk
export function applyOpen(ledger: Ledger, pos: OpenPosition): Ledger;
export function applyClose(ledger: Ledger, res: BracketResolution, closedAt: Date): Ledger;
export function markToMarket(ledger: Ledger, T: Date, closePrice: number): number; // equity = cash + unrealized
```

- `equity` = `startingEquity + realized` (cash) `+ unrealized` (si hay posición abierta).
- `unrealized` (MtM) = `(closePrice - entry) * size - entryFee` (sin fee de salida hasta cerrar).
- `drawdownPct` = `(peakEquity - equity) / peakEquity * 100`, con `peakEquity` actualizado sobre la
  curva (high-water mark).
- `dailyPnl` = suma de `realizedPnl` de cierres cuyo `closedAt` cae en el **mismo día UTC que `T`**.
  (Se computa sobre el reloj simulado; **no** se usa la query DB con `now()`.)
- `consecutiveLosses` = racha de cierres con `realizedPnl < 0` más recientes (misma regla que
  `getConsecutiveLosses`).
- `openNotionalTotal` / `openNotionalSymbol` / `openPositionsCount` desde `ledger.open`
  (single-símbolo: 0 ó 1).

### 3.3 `replay-driver.ts` — el loop barra a barra (determinista)

```ts
export function runReplay(strategy: Strategy, symbol: string, ds: BacktestDataSource, cfg: ReplayConfig): ReplayOutput;
// ReplayOutput = { trades: ClosedTrade[]; equityCurve: EquityPoint[]; finalLedger: Ledger }
```

El driver lleva una **orden pendiente diferida** (`pendingEntry`): la decisión de entrar se toma en la
barra `i` pero el fill se materializa al **open de `i+1`**. Esto evita toda inconsistencia temporal en
la equity curve (la posición nunca existe *durante* la barra que la generó). Por cada índice `i` de
`triggerCandles`, con `T = T_i`:

1. **Materializar entrada pendiente** (decidida en `i-1`). Si hay `pendingEntry` y no hay posición
   abierta: `refPrice = open_i`; `fill = simulateFill('buy', pendingEntry.size, refPrice, simParams)`;
   `applyOpen` con `entry = fill.fillPrice`, `size = fill.qty`, `entryFee = fill.fee`,
   `sl/tp = pendingEntry.verdict.sl/tp`, `openedAt = T_i`. Limpiar `pendingEntry`.
2. **Salida.** Si hay posición abierta, `resolveBracket(open, bar_i, simParams)` sobre la barra `i`.
   Si retorna resolución → `applyClose` (registra el trade, actualiza racha/dailyPnl/equity).
   *(SL primero si la barra toca ambos: ya garantizado por `resolveBracket`. Una posición recién
   materializada en el paso 1 puede cerrarse en esta misma barra `i` — entras al open y la barra cae
   al SL/TP: realista.)*
3. **Decisión de entrada** (para la barra siguiente). Si **no** hay posición abierta ni
   `pendingEntry`:
   - `candlesByTf = ds.closedCandlesAt(i)`; `deriv = ds.derivativesAt(T)`.
   - `signal = scan(strategy, symbol, candlesByTf, deriv, T)`. Si `null` → siguiente barra.
   - `verdict = buildDeterministicVerdict(signal, strategy)`. Si `action !== 'enter'` → siguiente.
   - `state = gatherState(ledger, T, close_i)`; `risk = evaluateRisk({ verdict, riskParams, ...state })`.
     Si `result !== 'allow'` → siguiente.
   - `pendingEntry = { verdict, size: risk.adjustedSize }` (se materializa en el paso 1 de `i+1`).
4. **Marca de equity**: `equityCurve.push({ t: T_i, equity: markToMarket(ledger, T_i, close_i) })`.

Al final de la ventana: una `pendingEntry` sin barra siguiente se descarta (no se pudo ejecutar); si
queda una posición abierta, cerrarla al último `close` como trade `hitType: 'eod'` (end-of-data) para
no inflar artificialmente el resultado.

**Matiz documentado (no es look-ahead):** `verdict.entry`/`sl`/`tp` y el sizing se anclan al **close
de `T_i`** (la señal se *planea* desde el último cierre, exactamente como en vivo); el **fill** de
entrada ocurre al **open de `T_{i+1}`** con slippage adverso. El precio que mueve dinero nunca es uno
que no se hubiera podido ejecutar.

### 3.4 `metrics.ts` — reporte comprensivo (§20.3), puro

`computeMetrics(trades, equityCurve, benchmark, window) → BacktestMetrics`. Serie de retornos a
**periodicidad diaria** (equity al final de cada día UTC); anualización con **365** (cripto 24/7),
`rf = 0`.

| Familia | Métricas | Notas |
|---|---|---|
| Retorno | CAGR, retorno total, retorno vs **buy-and-hold** | B&H = comprar al `open` de la 1ª barra de la ventana, vender al `close` de la última (mismo símbolo, con fees de sim). |
| Ajustadas a riesgo | **Sharpe**, **Sortino**, **Calmar** | Sharpe = `mean(r_d)/std(r_d)·√365`; Sortino usa downside deviation; Calmar = `CAGR / maxDD`. |
| Drawdown | **maxDD**, duración del DD, tiempo de recuperación | Sobre la equity curve (high-water mark). |
| Trade stats | **win rate**, profit factor, **expectancy**, avg win/loss, **payoff ratio** | `expectancy`/`payoff` = inputs de Kelly §19. Casos borde: 0 trades, 0 pérdidas (profit factor → `Infinity`/`null` documentado). |
| Actividad | nº trades, exposición media, turnover | Exposición media = fracción de barras con posición abierta. |

### 3.5 `run-backtest.ts` — orquestación

```ts
export interface BacktestConfig {
  strategyId: string; symbol: string; window: Window;
  startingEquity?: number;     // default DEFAULT_SIM_STARTING_EQUITY (10000)
  simParams?: SimParams;       // default DEFAULT_SIM_PARAMS
}
export interface BacktestResult { runId: string; metrics: BacktestMetrics; trades: ClosedTrade[]; equityCurve: EquityPoint[]; }
export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult>;
```

Carga estrategia (`getStrategy`) → `loadDataSource` → `runReplay` → `computeMetrics` →
`insertBacktestRun` → devuelve resultado. Si `getStrategy` es `null` o la ventana no tiene velas
suficientes para el warmup, falla rápido con error claro (validación en el límite).

### 3.6 `src/cli/backtest.ts` — CLI delgado

`npm run backtest -- --strategy <id> --symbol <SYM> --from <ISO> --to <ISO> [--equity N] [--sim-params <json>]`.
Acepta `--symbol` repetido: corre `runBacktest` por cada símbolo (iterado, independiente) e imprime
reporte por-símbolo + un agregado simple (suma de trades, promedio ponderado de stats). Valida args
con Valibot; imprime el reporte legible; persiste cada corrida. Sin `console.log` de debug.

## 4. Persistencia — DDL `kairos.backtest_runs`

**La tabla ya existe** en `src/db/schema.sql` (creada antes de SP4) con la forma de abajo, **sin**
`symbol` ni `trades` y con `window` como `tstzrange` (no `from`/`to` separados). SP4 la extiende
mínimamente editando el `CREATE TABLE IF NOT EXISTS` para incluir `symbol`/`trades`, más dos
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` idempotentes (porque `CREATE IF NOT EXISTS` no altera una
tabla ya migrada). No hay migraciones numeradas: `schema.sql` se aplica entero e idempotente con
`npm run migrate`. Append-first; el histórico es inmutable.

```sql
CREATE TABLE IF NOT EXISTS kairos.backtest_runs (
  id               text PRIMARY KEY,             -- ulid
  strategy_id      text NOT NULL REFERENCES kairos.strategies(id),
  strategy_version integer NOT NULL,
  symbol           text,                         -- añadido en SP4 (single-símbolo)
  "window"         tstzrange,                    -- ventana [from, to]
  mode             text NOT NULL CHECK (mode IN ('det', 'llm')),  -- 'det' en SP4; 'llm' reservado Fase 2
  sim_params       jsonb NOT NULL,
  metrics          jsonb NOT NULL,
  trades           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- añadido en SP4: lista compacta de ClosedTrade
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kairos.backtest_runs ADD COLUMN IF NOT EXISTS symbol text;
ALTER TABLE kairos.backtest_runs ADD COLUMN IF NOT EXISTS trades jsonb NOT NULL DEFAULT '[]'::jsonb;
```

Repo `backtest-runs.ts`: `insertBacktestRun(run) → string (id)` y un lector simple
`getBacktestRun(id)` para tests. (`metrics`/`sim_params` se serializan con `JSON.stringify`;
`numeric` no aplica aquí.)

## 5. Anti look-ahead — salvaguardas (§20.2), todas activas en SP4

| Riesgo (§20.2) | Salvaguarda concreta en SP4 |
|---|---|
| Ver el futuro en `T` | `data-source.closedCandlesAt` solo expone velas con **cierre ≤ T**; `scan` calcula indicadores solo sobre esas velas cerradas. |
| Fill al precio recién visto | Señal al close de `T` → **fill al open de `T+1`** (`simulateFill` con slippage). |
| Ambigüedad SL/TP intrabar | `resolveBracket` asume **SL primero** si la barra toca ambos (conservador). |
| Datos revisados | Point-in-time: cada vela/funding/OI con su `ts`; histórico append-only, sin valores corregidos. |
| Costos ignorados | Fees + slippage restados **siempre** (`simulateFill`/`resolveBracket`). |
| Sobre-ajuste | Walk-forward **diferido**; el point-in-time estricto es el blindaje núcleo presente. |
| Survivorship | Universo elegido por el operador vía `--symbol`; riesgo anotado, no resuelto en SP4. |

Test de borde explícito: una prueba que **falle** si el driver llegara a exponer una barra con
cierre `> T` (regresión de look-ahead).

## 6. Reproducibilidad (§20.4)

Una corrida queda fijada por: **ventana** (`window` tstzrange), **versión de estrategia**
(`strategy_version`), **snapshot de datos** (histórico inmutable), **parámetros de sim** (`sim_params`).
Como todo el code path es determinista y la contabilidad es pura, **la misma corrida produce métricas
idénticas** — esto se verifica con un test de reproducibilidad (dos `runReplay` → igualdad exacta).

## 7. Testing (objetivo ≥80% como en SP1–SP3)

- **Unit puros:**
  - `metrics`: cada fórmula con series conocidas (Sharpe/Sortino/Calmar/maxDD/profit factor/
    expectancy/payoff) + casos borde (0 trades, 0 pérdidas, equity plana).
  - `data-source`: nunca expone velas con cierre `> T`; warmup respetado; funding/OI `ts ≤ T`.
  - `accounting`: racha, `dailyPnl` en el **borde de día UTC** (cierre de "ayer" UTC excluido),
    drawdown high-water-mark, MtM con/ sin posición abierta.
  - `replay-driver`: fill-a-barra-siguiente (refPrice = open T+1), SL-primero, una-posición-a-la-vez,
    cierre `eod` al final.
- **Integración:** `runBacktest` end-to-end sobre un histórico **sembrado pequeño y determinista**
  (velas construidas para forzar 1–2 trades con SL y TP conocidos) → métricas esperadas exactas;
  **reproducibilidad** (misma corrida → mismas métricas); persistencia en `backtest_runs`.
- **Higiene de tests:** **símbolo dedicado por archivo** (lección del flaky de SP2:
  `scan-symbol.test.ts` × `ohlcv-candles.test.ts` colisionaron por compartir `TEST/USDT`); limpiar
  filas sembradas en `afterAll`.

## 8. Notas y deuda

- La deuda `getDailyRealizedPnl` (timezone de la conexión) **no muerde en SP4** (no se usa esa query);
  permanece pendiente para SP5, donde el `dailyPnl` real arma decisiones del loop vivo. Antes de SP5:
  fijar `SET TIME ZONE 'UTC'` en el pool o simplificar la fórmula, con test de borde.
- La estrategia semilla `pullback-alcista` es long-only; el backtester es long-only en SP4 (shorts
  fuera de alcance, coherente con §fases). `resolveBracket` y `buildDeterministicVerdict` ya asumen
  long.
- Si la estrategia no declara predicados de derivados, `derivativesAt` devuelve `{ fundingZ: null,
  oiChangePct: null }` y `scan` los ignora; no se exige cargar funding/OI en ese caso.

## 9. Orden de implementación sugerido (para el plan)

1. Verificar API real (TFs ms, firmas de `getCandles`/repos) contra los `.d.ts` instalados.
2. DDL + repo `backtest-runs` (con test).
3. `accounting.ts` (puro) + tests.
4. `metrics.ts` (puro) + tests.
5. `data-source.ts` (point-in-time) + tests.
6. `replay-driver.ts` (ensambla puras) + tests.
7. `run-backtest.ts` (orquestación + persistencia) + test de integración end-to-end.
8. `src/cli/backtest.ts` + script `npm run backtest`.
9. Revisión final de rama (suite completa en bucle) → merge local a `main`.
