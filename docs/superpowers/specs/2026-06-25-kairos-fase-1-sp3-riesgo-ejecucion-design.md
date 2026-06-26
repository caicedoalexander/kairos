# SP3 — Riesgo + ejecución sim · Diseño

> Fase 1 de Kairos, sub-proyecto 3 de 5. Depende de SP1 (market-data) y SP2 (scanner), ambos
> mergeados. Fuente de verdad del diseño global: `ARCHITECTURE.md` §18 (órdenes/ejecución) y §19
> (riesgo). Idioma: español; identificadores de código en su forma original.

## 1. Objetivo y alcance

SP3 implementa **todo el "camino del dinero" en modo `sim`**: desde una `signal` del scanner hasta
una posición abierta y, eventualmente, cerrada — todo determinista, idempotente y auditable. El LLM
no participa: el veredicto que normalmente produce el decision-maker se produce aquí por código.

**Principio rector (no negociable):** el LLM tiene juicio, no gatillo. Mover dinero (aunque sea
simulado) es siempre código determinista. Ninguna función de SP3 está en el `tools:[]` de un agente.

### En alcance

- **Productor de veredicto determinista** — `signal` → `Verdict` (entry/SL/TP/sizing_factor) → fila
  real en `decisions` con `model_used='deterministic'`.
- **`check_risk`** — sizing fijo-fraccional + stop ATR, límites duros deterministas, persiste
  `risk_evaluations`.
- **`paper-sim`** — modelo de fill paramétrico (precio peor que el mid: spread + slippage + fees) y
  resolución pura del bracket OCO (cierre por SL/TP, `realized_pnl`).
- **`execute_order` en sim** — orquestación idempotente (claim por `idempotency_key UNIQUE` antes de
  simular el fill), persistencia de `orders`/`fills`/`positions`, registro de los legs OCO.
- **Estado de cuenta mínimo** — `account_snapshots` sembrado con equity de arranque; se actualiza al
  cerrar posiciones (equity realizada).

### Fuera de alcance (diferido, con SP destino)

- **Executor testnet/live** y el guard de liquidez con **orderbook REST real** (`fetchOrderBook`
  book-walk) → SP5/live. SP3 es **sim-only**.
- **Driving barra a barra** de la resolución del bracket (replay histórico → SP4; monitor en vivo →
  SP5). SP3 **posee y testea** la función pura de resolución; no la conduce.
- **Mark-to-market** (equity no realizada, curva de equity barra a barra) → SP4 (métricas).
- **`pending_approvals`** del circuit-breaker (crear fila + resolución WhatsApp) → SP5. `check_risk`
  soporta el enum `needs_approval` por paridad, pero con circuit-breaker **default OFF** no se
  dispara en el loop determinista de Fase 1.
- **`close_position` / `cancel_order`** por canal de control (acciones humanas vía WhatsApp) → SP5.
- **Lock Redis** multi-worker → SP5 (junto con BullMQ). Ver §4.

## 2. Decisiones de diseño (resueltas en brainstorming)

| # | Decisión | Elección | Razón |
|---|---|---|---|
| 1 | Veredicto que alimenta `check_risk` dado `risk_evaluations.decision_id NOT NULL FK` | **Productor determinista escribe fila `decisions` real** (`model_used='deterministic'`, `tokens=0`, `reasoning=null`) | `check_risk`/`execute_order` quedan idénticos al futuro path LLM; cambiar a LLM en Fase 2 se localiza solo en el productor. **Cero cambio de esquema.** §20 ya enmarca el baseline determinista como fuente de decisión de primera clase. |
| 2 | Resolución del bracket OCO | **Apertura + función pura `resolveBracket` (cierre + `realized_pnl`), testeada en SP3** | La semántica de dinero del cierre (a qué precio llena SL/TP, gap-through) vive donde se prueba; SP4/SP5 solo la conducen. Evita dejar el cierre sin testear hasta SP4. |
| 3 | Idempotencia sin BullMQ/Redis (diferido a SP5) | **Claim por `INSERT orders` con `idempotency_key UNIQUE` antes de simular el fill** | Plenamente testeable en sim; el lock Redis (defensa multi-worker) se difiere a SP5 con BullMQ. En sim no hay exchange ni workers concurrentes que lo justifiquen aún. |
| 4 | Modelo de fill de `paper-sim` | **Paramétrico worse-than-mid** (`referencePrice` ajustado por spread + slippage + fees) | Idéntico en sim-vivo y backtest (SP4), donde no hay orderbook histórico. La función recibe `referencePrice`; el caller decide cuál (ask actual en vivo, apertura de barra siguiente en backtest = anti look-ahead). Cumple la línea roja "precio peor que mid". |

**SP3 no requiere DDL.** Todas las tablas (`decisions`, `risk_evaluations`, `orders`, `fills`,
`positions`, `account_snapshots`) ya existen en `src/db/schema.sql`. Solo se **extiende el seed** de
`risk_params` (datos, no esquema) y se **parsea** `risk_params` con Valibot (hoy es `unknown`).

## 3. Arquitectura y archivos

Nuevo módulo `src/lib/execution/`. Toda la lógica de dinero es **función pura** sobre estado ya
leído; solo `execute-order.ts` y los repos tocan la DB.

```
src/lib/execution/
  types.ts          Valibot schemas + tipos inferidos: Verdict, RiskParams, SimParams,
                    SizeBreakdown, RiskInput, RiskResult, FillResult, PositionForResolve,
                    BracketResolution, ExecutionResult
  limits.ts         Techos NO negociables en código + defaults:
                    MAX_RISK_PER_TRADE = 2.0, MIN_NOTIONAL = 10, DEFAULT_SIM_PARAMS
  verdict.ts        buildDeterministicVerdict(signal, strategy) → Verdict           [puro]
  sizing.ts         computeSize(equity, verdict, riskParams) → SizeBreakdown        [puro]
  check-risk.ts     evaluateRisk(input: RiskInput) → RiskResult                     [puro]
                    checkRiskForDecision(decision, strategy, mode) → RiskResult     [wrapper DB]
  fill.ts           simulateFill(side, size, referencePrice, simParams) → FillResult [puro]
  bracket.ts        resolveBracket(position, bar, simParams) → BracketResolution|null [puro]
  execute-order.ts  executeOrderSim(decision, strategy, referencePrice, simParams, mode)
                    → ExecutionResult                          [orquestador, idempotente, tx]
src/db/repositories/
  decisions.ts          insertDecision(d) / getDecision(id)
  risk-evaluations.ts   insertRiskEvaluation(r)
  orders.ts             claimEntryOrder(...) [INSERT ON CONFLICT DO NOTHING],
                        getOrderByIdempotencyKey(key), insertBracketLeg(...), updateOrderStatus(...)
  fills.ts              insertFill(f)
  positions.ts          openPosition(p), closePosition(id, exit, realizedPnl, closedAt),
                        getOpenPositions(mode) [+ agregados de exposición], getConsecutiveLosses(mode)
  account-snapshots.ts  getLatestSnapshot(), appendSnapshot(s), ensureInitialSnapshot(startingEquity)
src/db/seed-strategies.ts   (modificar: extender RISK_PARAMS)
```

`audit_log` reutiliza el repo existente `src/db/repositories/audit-log.ts` (no se crea uno nuevo).

## 4. Tipos e interfaces (Valibot)

Porcentajes en `risk_params` se almacenan como **números enteros de punto porcentual** (consistente
con el seed actual: `0.5` = 0.5%, `10` = 10%). El código divide por 100 al usarlos.

```ts
// Verdict — análogo determinista del veredicto del decision-maker LLM.
const VerdictSchema = v.object({
  action: v.picklist(['enter', 'skip']),
  entry: v.number(),          // precio de referencia estimado (close del TF trigger)
  sl: v.number(),
  tp: v.number(),
  sizingFactor: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),  // determinista: 1.0
  reason: v.optional(v.string()),  // motivo del 'skip' (atrPct nulo, etc.)
});

// RiskParams — config por estrategia. Se parsea al leer la estrategia.
const RiskParamsSchema = v.object({
  risk_per_trade_pct:      v.pipe(v.number(), v.minValue(0)),   // p.ej. 0.5
  atr_stop_mult:           v.pipe(v.number(), v.minValue(0)),   // k del stop ATR, p.ej. 1.5
  tp_r_multiple:           v.pipe(v.number(), v.minValue(0)),   // tp = entry + R·stop_distance
  max_notional_pct:        v.pipe(v.number(), v.minValue(0)),   // por posición, % del equity
  max_total_exposure_pct:  v.pipe(v.number(), v.minValue(0)),   // Σ notional abierto
  max_open_positions:      v.pipe(v.number(), v.integer(), v.minValue(0)),
  max_symbol_exposure_pct: v.pipe(v.number(), v.minValue(0)),
  max_daily_loss_pct:      v.pipe(v.number(), v.minValue(0)),
  max_drawdown_pct:        v.pipe(v.number(), v.minValue(0)),
  max_consecutive_losses:  v.pipe(v.number(), v.integer(), v.minValue(0)),
});

// SimParams — parámetros del modelo de fill paramétrico (no por estrategia en SP3; default global).
const SimParamsSchema = v.object({
  spread_bps:   v.pipe(v.number(), v.minValue(0)),   // half-spread aplicado
  slippage_bps: v.pipe(v.number(), v.minValue(0)),
  fee_bps:      v.pipe(v.number(), v.minValue(0)),   // taker
});

// RiskResult — salida de check_risk (persistida en risk_evaluations).
const RiskResultSchema = v.object({
  result: v.picklist(['allow', 'deny', 'needs_approval']),
  reason: v.string(),
  adjustedSize: v.nullable(v.number()),   // size capado si allow, null si deny
  notional: v.nullable(v.number()),
  limitsSnapshot: v.record(v.string(), v.unknown()),  // estado evaluado, para auditoría
});
```

Tipos auxiliares (no Valibot, internos):

```ts
interface SizeBreakdown { size: number; notional: number; riskAmount: number; stopDistance: number; }
interface FillResult { fillPrice: number; qty: number; fee: number; slippageBps: number; }
interface PositionForResolve { entry: number; size: number; sl: number; tp: number; entryFee: number; }
type BarOHLC = { open: number; high: number; low: number; close: number };
interface BracketResolution {
  hitType: 'sl' | 'tp';
  exitPrice: number;
  exitFee: number;
  realizedPnl: number;   // neto: (exit−entry)·size − entryFee − exitFee
}
interface ExecutionResult {
  status: 'filled' | 'pending_execution' | 'duplicate';
  idempotencyKey: string;
  orderId: string;
  positionId: string | null;
  fillPrice: number | null;
  qty: number | null;
  fee: number | null;
}
```

`DEFAULT_SIM_PARAMS = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 }` (fee 0.1% taker de Binance
spot; spread/slippage conservadores). `MAX_RISK_PER_TRADE = 2.0` (techo duro de % de riesgo por
trade, §19; el LLM jamás lo supera). `MIN_NOTIONAL = 10` (evita órdenes polvo; análogo al filtro
`minNotional` de Binance, simplificado para sim).

## 5. Productor de veredicto determinista (`verdict.ts`)

`buildDeterministicVerdict(signal: Signal, strategy: Strategy): Verdict` — puro.

```
tf       = strategy.triggerConfig.timeframes.trigger
f        = signal.snapshot.byTimeframe[tf]
entry    = f.close
atrPct   = f.atrPct
// Defensivo: sin entry/atr válidos no se puede sizing seguro → skip (no se ejecuta).
if (entry == null || entry <= 0 || atrPct == null || atrPct <= 0)
    return { action: 'skip', entry: 0, sl: 0, tp: 0, sizingFactor: 1, reason: 'atr/entry inválidos' }

rp            = parseRiskParams(strategy.riskParams)
atr_abs       = (atrPct / 100) * entry           // atrPct viene en puntos porcentuales
stop_distance = rp.atr_stop_mult * atr_abs
sl            = entry - stop_distance             // long-only: SL debajo
tp            = entry + rp.tp_r_multiple * stop_distance
return { action: 'enter', entry, sl, tp, sizingFactor: 1.0 }
```

El veredicto se persiste en `decisions`: `{ id: ulid(), signal_id: signal.id, verdict: <Verdict>,
reasoning: null, technical_read: null, fundamental_read: null, model_used: 'deterministic',
tokens: 0 }`. **Nota de integración:** `signal.id` debe existir; el productor se invoca sobre una
señal ya persistida por SP2 (`insertSignal`).

## 6. Sizing (`sizing.ts`)

`computeSize(equity: number, verdict: Verdict, riskParams: RiskParams): SizeBreakdown` — puro.

```
risk_pct      = min(riskParams.risk_per_trade_pct, MAX_RISK_PER_TRADE)   // techo duro de código
risk_amount   = equity * (risk_pct / 100)
stop_distance = verdict.entry - verdict.sl                                // > 0 garantizado (verdict 'enter')
size          = (risk_amount / stop_distance) * verdict.sizingFactor
notional      = size * verdict.entry
return { size, notional, riskAmount: risk_amount, stopDistance: stop_distance }
```

El `sizing_factor` solo **reduce** dentro del presupuesto (∈[0,1]); en Fase 1 es siempre `1.0`.

## 7. check_risk (`check-risk.ts`)

### 7.1 Núcleo puro — `evaluateRisk(input: RiskInput): RiskResult`

```ts
interface RiskInput {
  verdict: Verdict;               // action 'enter'
  riskParams: RiskParams;
  equity: number;
  openNotionalTotal: number;      // Σ notional de posiciones abiertas (mismo mode)
  openNotionalSymbol: number;     // Σ notional abierto del símbolo del veredicto
  openPositionsCount: number;
  dailyPnl: number;               // realizado del día UTC (de account_snapshots)
  drawdownPct: number;            // (peak−equity)/peak·100 (de account_snapshots)
  consecutiveLosses: number;      // racha de cierres con realized_pnl<0
}
```

**Orden de evaluación** (deny-gates baratos primero, luego sizing y caps que reducen):

1. **Drawdown desde el pico** — `drawdownPct ≥ max_drawdown_pct` → `deny` (kill-switch global;
   reanudar es manual, §19.4). *No auto-liquida posiciones abiertas.*
2. **Pérdida diaria** — `(dailyPnl / equity)·100 ≤ −max_daily_loss_pct` → `deny` (corta nuevas
   entradas hasta el siguiente día UTC).
3. **Pérdidas consecutivas** — `consecutiveLosses ≥ max_consecutive_losses` → `deny` (circuit-breaker
   OFF en Fase 1; con ON sería `needs_approval`).
4. **Concurrencia** — `openPositionsCount ≥ max_open_positions` → `deny`.
5. **Sizing** — `computeSize(equity, verdict, riskParams)` → `size`, `notional`.
6. **Cap notional por posición** — si `notional > equity·max_notional_pct/100` → reduce
   `size = equity·max_notional_pct/100 / entry`; recalcula `notional`.
7. **Cap exposición total** — `remaining = equity·max_total_exposure_pct/100 − openNotionalTotal`;
   si `remaining ≤ 0` → `deny`; si `notional > remaining` → reduce `size` a `remaining/entry`.
8. **Cap exposición por símbolo** — análogo con `max_symbol_exposure_pct` y `openNotionalSymbol`.
9. **Notional mínimo** — si `notional < MIN_NOTIONAL` tras reducciones → `deny` (orden polvo).
10. Si sobrevive → `allow` con `adjustedSize = size` (capado) y `notional`.

`limitsSnapshot` registra todos los valores evaluados (equity, exposiciones, drawdown, daily, caps)
para auditoría reproducible. Cada `deny` lleva `reason` legible.

### 7.2 Wrapper DB — `checkRiskForDecision(decision, strategy, mode): Promise<RiskResult>`

Reúne el estado y persiste el veredicto:

```
snapshot   = getLatestSnapshot()                       // equity, peak_equity, drawdown, daily_pnl
openAgg    = getOpenPositions(mode)                     // → totales y por símbolo, count
losses     = getConsecutiveLosses(mode)                 // racha de realized_pnl<0 (cierres recientes)
input      = { verdict: decision.verdict, riskParams: parseRiskParams(strategy.riskParams),
               equity: snapshot.equity, openNotionalTotal, openNotionalSymbol, openPositionsCount,
               dailyPnl: snapshot.daily_pnl, drawdownPct: snapshot.drawdown, consecutiveLosses }
result     = evaluateRisk(input)
insertRiskEvaluation({ id: ulid(), decision_id: decision.id, result: result.result,
                       reason: result.reason, adjusted_size: result.adjustedSize,
                       limits_snapshot: result.limitsSnapshot })
return result
```

## 8. paper-sim: modelo de fill (`fill.ts`)

`simulateFill(side: 'buy'|'sell', size: number, referencePrice: number, simParams: SimParams):
FillResult` — puro. **Siempre precio peor que el mid** (línea roja de honestidad, §10/§18.2).

```
adverse = (simParams.spread_bps / 2 + simParams.slippage_bps) / 1e4
fillPrice = side === 'buy'
    ? referencePrice * (1 + adverse)    // comprar más caro
    : referencePrice * (1 - adverse)    // vender más barato
qty  = size                              // fill total en sim (sin parciales; se anota como simplificación)
fee  = fillPrice * qty * (simParams.fee_bps / 1e4)
return { fillPrice, qty, fee, slippageBps: simParams.spread_bps / 2 + simParams.slippage_bps }
```

Llenado parcial (IOC parcial real, §18.3) se difiere: en sim se asume liquidez suficiente para el
`size` ya capado por `check_risk`. (En live, el book-walk real puede llenar parcial → SP5.)

## 9. paper-sim: resolución del bracket (`bracket.ts`)

`resolveBracket(position: PositionForResolve, bar: BarOHLC, simParams: SimParams):
BracketResolution | null` — puro. La conduce SP4 (replay) / SP5 (monitor); SP3 la posee y testea.

Convención **honesta** (el backtest no miente, §20):

```
hitSl = bar.low  <= position.sl
hitTp = bar.high >= position.tp

if (!hitSl && !hitTp) return null            // la vela no resuelve el bracket

// Ambos en la misma vela → se asume SL primero (peor caso).
if (hitSl) {
    // Stop = market: slippage de venta (peor). Gap-through: si abre debajo del SL, llena al open.
    ref      = Math.min(position.sl, bar.open)
    exitFill = simulateFill('sell', position.size, ref, simParams)   // fillPrice ≤ ref
    exitPrice = exitFill.fillPrice
    hitType  = 'sl'
} else {
    // TP = limit: llena EXACTAMENTE a tp (sin slippage favorable, conservador). Fee igual aplica.
    exitPrice = position.tp
    exitFee0  = position.tp * position.size * (simParams.fee_bps / 1e4)
    hitType   = 'tp'
}
exitFee     = (hitType === 'sl') ? exitFill.fee : exitFee0
realizedPnl = (exitPrice - position.entry) * position.size - position.entryFee - exitFee
return { hitType, exitPrice, exitFee, realizedPnl }
```

El wrapper que conduce el cierre (SP4/SP5, o el test de SP3) lee `entryFee` del `fill` de entrada,
arma `PositionForResolve`, llama a `resolveBracket`, y si hay resolución: `closePosition(id, exitPrice,
realizedPnl, closedAt)` + `appendSnapshot(...)` con la nueva equity realizada.

## 10. execute_order en sim (`execute-order.ts`)

Firma (objeto de opciones para legibilidad):

```ts
interface ExecuteOrderSimParams {
  signal: Signal;          // aporta symbol e id (= idempotency_key)
  decision: { id: string; verdict: Verdict };
  riskResult: RiskResult;  // result 'allow', con adjustedSize
  strategy: Strategy;      // aporta strategy_id
  referencePrice: number;  // ask actual (vivo) o apertura de barra siguiente (backtest)
  simParams: SimParams;
  mode: 'sim';
}
```

`executeOrderSim(p: ExecuteOrderSimParams): Promise<ExecutionResult>` — orquestador determinista e
**idempotente**. Todo en una **transacción** pg.

```
idem = p.signal.id        // §18.3: idempotency_key = signalId

BEGIN
  // 1. Claim: INSERT entry order ON CONFLICT (idempotency_key) DO NOTHING RETURNING id
  claimed = claimEntryOrder({ id: ulid(), idempotency_key: idem, decision_id: p.decision.id,
                              side: 'buy', size: p.riskResult.adjustedSize, type: 'limit',
                              tif: 'IOC', purpose: 'entry', status: 'pending', mode: p.mode })
  if (!claimed) {
    // Ya existía → replay idempotente: devuelve el resultado existente, sin duplicar.
    existing = getOrderByIdempotencyKey(idem)
    COMMIT
    return { status: 'duplicate', ... derivado de existing }
  }

  // 2. Fill paramétrico (precio peor que mid).
  fill = simulateFill('buy', p.riskResult.adjustedSize, p.referencePrice, p.simParams)

  // 3. Persistir fill + abrir posición + marcar la entry como filled.
  insertFill({ id: ulid(), order_id: claimed.id, price: fill.fillPrice, qty: fill.qty, fee: fill.fee })
  positionId = openPosition({ id: ulid(), symbol: p.signal.symbol, side: 'long', entry: fill.fillPrice,
                              size: fill.qty, sl: p.decision.verdict.sl, tp: p.decision.verdict.tp,
                              status: 'open', strategy_id: p.strategy.id, mode: p.mode })
  updateOrderStatus(claimed.id, 'filled')

  // 4. Registrar legs OCO (no se "ejecutan" aún; los resuelve resolveBracket).
  insertBracketLeg({ idempotency_key: `${idem}:sl`, purpose: 'sl', parent_id: claimed.id, ... })
  insertBracketLeg({ idempotency_key: `${idem}:tp`, purpose: 'tp', parent_id: claimed.id, ... })

  // 5. Auditoría.
  insertAuditLog({ event_type: 'order_filled_sim', actor: 'execute_order', payload: {...} })
COMMIT
return { status: 'filled', idempotencyKey: idem, orderId: claimed.id, positionId,
         fillPrice: fill.fillPrice, qty: fill.qty, fee: fill.fee }
```

**Invariantes (§18.3) que aplican en sim:**
- **Claim antes del fill:** el `INSERT orders` (UNIQUE) ocurre antes de simular el llenado. Reintentar
  nunca duplica (segunda llamada → `duplicate`).
- **Size real desde el fill:** la posición y los legs usan el `qty` llenado, no el size pedido.
- **Sin hueco entrada→OCO en sim:** todo en proceso, una transacción.
- **Incertidumbre de ejecución:** en sim el fill es síncrono y determinista → no surge
  `pending_execution`; el estado existe en el tipo por paridad con live (SP5), donde sí aplica.
- **El lock Redis (claim multi-worker) se difiere a SP5;** en sim el `UNIQUE` de DB es el guard
  durable suficiente.

## 11. Estado, equity y modos

- **Equity realizada (simplificación Fase 1):** `equity = SIM_STARTING_EQUITY + Σ realized_pnl`.
  Abrir posición **no** cambia equity; bloquea `notional` como exposición usada (los caps la suman de
  `positions`). Cerrar realiza P&L → `appendSnapshot` recalcula `peak_equity = max(peak_prev, equity)`,
  `drawdown = (peak_equity − equity)/peak_equity · 100`, `daily_pnl = Σ realized_pnl desde 00:00 UTC`.
  El **mark-to-market** (equity no realizada barra a barra) se difiere a SP4.
- **Snapshot inicial:** `ensureInitialSnapshot(startingEquity)` siembra el primer `account_snapshots`
  (`equity = peak_equity = SIM_STARTING_EQUITY`, `drawdown = 0`, `daily_pnl = 0`) si no hay ninguno.
  `SIM_STARTING_EQUITY` por env (default `10000`).
- **Modo:** SP3 es **sim-only**; `executeOrderSim` escribe `mode='sim'`. El branch testnet/live no se
  implementa. `account_snapshots` no tiene columna `mode` — aceptable mientras solo corre sim;
  añadirla queda anotado para testnet/live (YAGNI ahora).

## 12. Seed: extensión de `risk_params`

`seed-strategies.ts` actualiza `RISK_PARAMS` de `pullback-alcista` para incluir todos los campos que
`check_risk` consume (el `ON CONFLICT DO UPDATE` ya refresca `risk_params`). Valores iniciales
conservadores:

```ts
const RISK_PARAMS = {
  risk_per_trade_pct: 0.5,        // existente
  atr_stop_mult: 1.5,             // existente
  tp_r_multiple: 2.0,             // nuevo: TP a 2R
  max_notional_pct: 10,           // existente
  max_total_exposure_pct: 30,     // nuevo
  max_open_positions: 3,          // nuevo
  max_symbol_exposure_pct: 15,    // nuevo
  max_daily_loss_pct: 3,          // nuevo
  max_drawdown_pct: 15,           // nuevo
  max_consecutive_losses: 4,      // nuevo
};
```

## 13. Validación, errores y testing

- **Valibot** en límites: `parseRiskParams` (lanza ante config malformada = fail loud), `VerdictSchema`,
  `SimParamsSchema`, `RiskResultSchema`.
- **Defensivo:** `buildDeterministicVerdict` devuelve `action:'skip'` sin entry/atr válidos; `computeSize`
  opera sobre `stop_distance > 0` (garantizado por veredicto `'enter'`). Sin divisiones por cero.
- **Idempotencia testeada:** doble `executeOrderSim` con el mismo `signal.id` ⇒ una sola posición y una
  sola entry order; el segundo devuelve `status:'duplicate'`.
- **Honestidad testeada:** `simulateFill('buy', …)` ⇒ `fillPrice > referencePrice`; `('sell', …)` ⇒
  `fillPrice < referencePrice`; `fee > 0` siempre.
- **`resolveBracket` (unit puro):** vela toca solo SL; solo TP; ninguno (`null`); ambos (gana SL);
  gap-through (open por debajo del SL → llena al open, no al SL); `realized_pnl` neto de fees correcto.
- **`evaluateRisk` (unit puro):** allow normal; cada deny-gate (drawdown, pérdida diaria, consecutivas,
  concurrencia); cap notional reduce size; cap exposición total/símbolo reduce o deny; notional mínimo.
- **Integración (DB):** `decisions`/`risk_evaluations`/`orders`/`fills`/`positions`/`account_snapshots`
  round-trip; flujo signal→verdict→check_risk(allow)→executeOrderSim→posición abierta→resolveBracket
  (TP)→posición cerrada con `realized_pnl` y snapshot actualizado.
- **Símbolo dedicado por archivo de test** (lección de SP2: los archivos de Vitest corren en paralelo;
  compartir símbolo causa flakiness por colisión de datos). Cada `*.test.ts` que toca DB usa su propio
  símbolo (`EXECBTC/USDT`, `RISKBTC/USDT`, …). `beforeAll(migrate())` / `afterAll(pool.end())`.
- **Estilo:** funciones <50 líneas, archivos <800, anidamiento ≤4, inmutabilidad por defecto, sin
  secretos hardcodeados, sin `console.log` de debug. Cobertura objetivo ≥80%.

## 14. Orden de implementación (resumen para el plan)

1. `types.ts` + `limits.ts` (schemas/constantes, base de todo).
2. `verdict.ts` + repo `decisions.ts`.
3. `sizing.ts`.
4. `check-risk.ts` (`evaluateRisk` puro) + repo `risk-evaluations.ts`.
5. `fill.ts`.
6. `bracket.ts`.
7. Repos `orders.ts` / `fills.ts` / `positions.ts` / `account-snapshots.ts`.
8. `execute-order.ts` (orquestador idempotente, transaccional).
9. `checkRiskForDecision` wrapper (integra repos + `evaluateRisk`).
10. Extensión del seed `risk_params` + parseo Valibot al leer estrategia.
11. Integración end-to-end (signal→…→cierre) con símbolo dedicado.
