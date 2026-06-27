import type { ClosedTrade, EquityPoint, BacktestMetrics, Window } from './types.ts';

const DAY_MS = 86_400_000;
const ANNUALIZATION = 365; // cripto opera 24/7

export interface MetricsInput {
  trades: readonly ClosedTrade[];
  equityCurve: readonly EquityPoint[];
  startingEquity: number;
  buyHold: { entryPrice: number; exitPrice: number };
  window: Window;
}

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

// Equity al último punto de cada día UTC → retornos diarios.
function dailyReturns(curve: readonly EquityPoint[]): number[] {
  const lastByDay = new Map<string, number>();
  for (const p of curve) lastByDay.set(utcDayKey(p.t), p.equity);
  const equities = [...lastByDay.values()];
  const returns: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    if (equities[i - 1] !== 0) returns.push(equities[i] / equities[i - 1] - 1);
  }
  return returns;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function downsideStd(xs: readonly number[]): number {
  const neg = xs.filter((x) => x < 0);
  if (neg.length === 0) return 0;
  return Math.sqrt(neg.reduce((a, b) => a + b ** 2, 0) / xs.length);
}

interface DrawdownStats { maxDrawdownPct: number; drawdownDurationDays: number; recoveryDays: number | null; }

function drawdownStats(curve: readonly EquityPoint[]): DrawdownStats {
  let peak = curve.length ? curve[0].equity : 0;
  let peakT = curve.length ? curve[0].t : new Date(0);
  let maxDd = 0;
  let troughT = peakT;
  let ddPeakT = peakT;
  let recovered = true;
  let recoveryMs: number | null = null;
  for (const p of curve) {
    if (p.equity > peak) {
      if (!recovered && troughT) recoveryMs = p.t.getTime() - troughT.getTime();
      peak = p.equity; peakT = p.t; recovered = true;
    } else {
      const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
      if (dd > maxDd) { maxDd = dd; troughT = p.t; ddPeakT = peakT; recovered = false; }
    }
  }
  const durationDays = maxDd > 0 ? (troughT.getTime() - ddPeakT.getTime()) / DAY_MS : 0;
  return { maxDrawdownPct: maxDd, drawdownDurationDays: durationDays, recoveryDays: recoveryMs === null ? null : recoveryMs / DAY_MS };
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const { trades, equityCurve, startingEquity, buyHold, window } = input;
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingEquity;
  const totalReturnPct = startingEquity > 0 ? ((finalEquity - startingEquity) / startingEquity) * 100 : 0;

  const days = Math.max((window.to.getTime() - window.from.getTime()) / DAY_MS, 1 / 24);
  const years = days / ANNUALIZATION;
  const growth = startingEquity > 0 ? finalEquity / startingEquity : 1;
  const cagrPct = growth > 0 && years > 0 ? (growth ** (1 / years) - 1) * 100 : 0;

  const buyHoldReturnPct = buyHold.entryPrice > 0 ? ((buyHold.exitPrice - buyHold.entryPrice) / buyHold.entryPrice) * 100 : 0;

  const r = dailyReturns(equityCurve);
  const sd = std(r);
  const dsd = downsideStd(r);
  const sharpe = sd > 0 ? (mean(r) / sd) * Math.sqrt(ANNUALIZATION) : 0;
  const sortino = dsd > 0 ? (mean(r) / dsd) * Math.sqrt(ANNUALIZATION) : 0;

  const dd = drawdownStats(equityCurve);
  const calmar = dd.maxDrawdownPct > 0 ? cagrPct / dd.maxDrawdownPct : 0;

  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;
  const expectancy = trades.length ? trades.reduce((a, t) => a + t.realizedPnl, 0) / trades.length : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const payoffRatio = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null;

  const heldMs = trades.reduce((a, t) => a + (t.closedAt.getTime() - t.openedAt.getTime()), 0);
  const windowMs = Math.max(window.to.getTime() - window.from.getTime(), 1);
  const exposurePct = Math.min(100, (heldMs / windowMs) * 100);
  const turnover = startingEquity > 0 ? trades.reduce((a, t) => a + t.entry * t.size, 0) / startingEquity : 0;

  return {
    totalReturnPct, cagrPct, buyHoldReturnPct,
    sharpe, sortino, calmar,
    maxDrawdownPct: dd.maxDrawdownPct, drawdownDurationDays: dd.drawdownDurationDays, recoveryDays: dd.recoveryDays,
    trades: trades.length, winRate, profitFactor, expectancy, avgWin, avgLoss, payoffRatio,
    exposurePct, turnover,
  };
}
