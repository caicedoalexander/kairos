import { computeSize } from './sizing.ts';
import { MIN_NOTIONAL } from './limits.ts';
import type { RiskInput, RiskResult } from './types.ts';

function deny(reason: string, snap: Record<string, unknown>): RiskResult {
  return { result: 'deny', reason, adjustedSize: null, notional: null, limitsSnapshot: snap };
}

// Núcleo puro de check_risk (§19.2): deny-gates baratos primero, luego sizing + caps que reducen.
export function evaluateRisk(input: RiskInput): RiskResult {
  const { verdict, riskParams: rp, equity } = input;
  const snap: Record<string, unknown> = {
    equity, drawdownPct: input.drawdownPct, dailyPnl: input.dailyPnl,
    openNotionalTotal: input.openNotionalTotal, openNotionalSymbol: input.openNotionalSymbol,
    openPositionsCount: input.openPositionsCount, consecutiveLosses: input.consecutiveLosses,
  };

  if (input.drawdownPct >= rp.max_drawdown_pct) return deny('drawdown sobre el límite (kill-switch)', snap);
  if ((input.dailyPnl / equity) * 100 <= -rp.max_daily_loss_pct) return deny('pérdida diaria sobre el límite', snap);
  if (input.consecutiveLosses >= rp.max_consecutive_losses) return deny('pérdidas consecutivas sobre el límite', snap);
  if (input.openPositionsCount >= rp.max_open_positions) return deny('máximo de posiciones abiertas alcanzado', snap);

  const base = computeSize(equity, verdict, rp);
  let size = base.size;
  let notional = base.notional;

  const maxNotional = equity * (rp.max_notional_pct / 100);
  if (notional > maxNotional) { size = maxNotional / verdict.entry; notional = size * verdict.entry; }

  const remainingTotal = equity * (rp.max_total_exposure_pct / 100) - input.openNotionalTotal;
  if (remainingTotal <= 0) return deny('exposición total sobre el límite', snap);
  if (notional > remainingTotal) { size = remainingTotal / verdict.entry; notional = size * verdict.entry; }

  const remainingSymbol = equity * (rp.max_symbol_exposure_pct / 100) - input.openNotionalSymbol;
  if (remainingSymbol <= 0) return deny('exposición del símbolo sobre el límite', snap);
  if (notional > remainingSymbol) { size = remainingSymbol / verdict.entry; notional = size * verdict.entry; }

  if (notional < MIN_NOTIONAL) return deny('notional bajo el mínimo', snap);

  return { result: 'allow', reason: 'ok', adjustedSize: size, notional, limitsSnapshot: { ...snap, adjustedSize: size, notional } };
}
