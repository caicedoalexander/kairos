import type { Verdict, SimParams } from '../execution/types.ts';

export interface Window { from: Date; to: Date; }

export interface OpenPosition {
  entry: number; size: number; sl: number; tp: number; entryFee: number; openedAt: Date;
}

export interface ClosedTrade {
  openedAt: Date; closedAt: Date; entry: number; exit: number; size: number;
  fees: number; realizedPnl: number; hitType: 'sl' | 'tp' | 'eod'; rMultiple: number;
}

export interface EquityPoint { t: Date; equity: number; }

export interface Ledger {
  startingEquity: number;
  realized: number;
  peakEquity: number;
  open: OpenPosition | null;
  trades: readonly ClosedTrade[];
}

export interface TradeClose {
  hitType: 'sl' | 'tp' | 'eod'; exitPrice: number; exitFee: number; realizedPnl: number;
}

// Tipos de Task 3 (metrics) y Task 6 (run) — declarados aquí para que todos los módulos compartan.
export interface BacktestMetrics {
  totalReturnPct: number; cagrPct: number; buyHoldReturnPct: number;
  sharpe: number; sortino: number; calmar: number;
  maxDrawdownPct: number; drawdownDurationDays: number; recoveryDays: number | null;
  trades: number; winRate: number; profitFactor: number | null;
  expectancy: number; avgWin: number; avgLoss: number; payoffRatio: number | null;
  exposurePct: number; turnover: number;
}

export interface BacktestConfig {
  strategyId: string; symbol: string; window: Window;
  startingEquity?: number; simParams?: SimParams;
}

export interface BacktestResult {
  runId: string; symbol: string; metrics: BacktestMetrics;
  trades: ClosedTrade[]; equityCurve: EquityPoint[];
}

export interface ReplayOutput {
  trades: ClosedTrade[]; equityCurve: EquityPoint[]; finalLedger: Ledger;
}
