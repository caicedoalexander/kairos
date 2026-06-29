import * as v from 'valibot';

// ── Verdict (análogo determinista del veredicto del decision-maker) ──
export const VerdictSchema = v.object({
  action: v.picklist(['enter', 'skip']),
  entry: v.number(),
  sl: v.number(),
  tp: v.number(),
  sizingFactor: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  reason: v.optional(v.string()),
});
export type Verdict = v.InferOutput<typeof VerdictSchema>;

// ── RiskParams (config por estrategia; porcentajes en puntos porcentuales) ──
export const RiskParamsSchema = v.object({
  risk_per_trade_pct: v.pipe(v.number(), v.minValue(0)),
  atr_stop_mult: v.pipe(v.number(), v.minValue(0)),
  tp_r_multiple: v.pipe(v.number(), v.minValue(0)),
  max_notional_pct: v.pipe(v.number(), v.minValue(0)),
  max_total_exposure_pct: v.pipe(v.number(), v.minValue(0)),
  max_open_positions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  max_symbol_exposure_pct: v.pipe(v.number(), v.minValue(0)),
  max_daily_loss_pct: v.pipe(v.number(), v.minValue(0)),
  max_drawdown_pct: v.pipe(v.number(), v.minValue(0)),
  max_consecutive_losses: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type RiskParams = v.InferOutput<typeof RiskParamsSchema>;

export function parseRiskParams(raw: unknown): RiskParams {
  return v.parse(RiskParamsSchema, raw);
}

// ── SimParams (modelo de fill paramétrico) ──
export const SimParamsSchema = v.object({
  spread_bps: v.pipe(v.number(), v.minValue(0)),
  slippage_bps: v.pipe(v.number(), v.minValue(0)),
  fee_bps: v.pipe(v.number(), v.minValue(0)),
});
export type SimParams = v.InferOutput<typeof SimParamsSchema>;

// ── RiskResult (salida de check_risk; persistida en risk_evaluations) ──
export const RiskResultSchema = v.object({
  result: v.picklist(['allow', 'deny', 'needs_approval']),
  reason: v.string(),
  adjustedSize: v.nullable(v.number()),
  notional: v.nullable(v.number()),
  limitsSnapshot: v.record(v.string(), v.unknown()),
});
export type RiskResult = v.InferOutput<typeof RiskResultSchema>;

// ── Tipos auxiliares (no Valibot) ──
export interface SizeBreakdown { size: number; notional: number; riskAmount: number; stopDistance: number; }

export interface RiskInput {
  verdict: Verdict;
  riskParams: RiskParams;
  equity: number;
  openNotionalTotal: number;
  openNotionalSymbol: number;
  openPositionsCount: number;
  dailyPnl: number;
  drawdownPct: number;
  consecutiveLosses: number;
}

export interface FillResult { fillPrice: number; qty: number; fee: number; slippageBps: number; }

export interface PositionForResolve { entry: number; size: number; sl: number; tp: number; entryFee: number; }
export interface BarOHLC { open: number; high: number; low: number; close: number; }
export interface BracketResolution { hitType: 'sl' | 'tp'; exitPrice: number; exitFee: number; realizedPnl: number; }

export interface ExecutionResult {
  status: 'filled' | 'pending_execution' | 'duplicate' | 'deduped' | 'zero_fill' | 'emergency_closed';
  idempotencyKey: string;
  orderId: string;
  positionId: string | null;
  fillPrice: number | null;
  qty: number | null;
  fee: number | null;
}
