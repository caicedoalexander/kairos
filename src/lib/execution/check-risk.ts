import { computeSize } from './sizing.ts';
import { MIN_NOTIONAL, DEFAULT_SIM_STARTING_EQUITY } from './limits.ts';
import { parseRiskParams } from './types.ts';
import type { RiskInput, RiskResult, Verdict } from './types.ts';
import { getExposure, getConsecutiveLosses, getDailyRealizedPnl } from '../../db/repositories/positions.ts';
import { getLatestSnapshot } from '../../db/repositories/account-snapshots.ts';
import { insertRiskEvaluation } from '../../db/repositories/risk-evaluations.ts';
import type { Strategy } from '../scanner/types.ts';
import type { TradingMode } from '../mode.ts';

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

export interface GatheredState {
  equity: number; drawdownPct: number; dailyPnl: number;
  openNotionalTotal: number; openNotionalSymbol: number; openPositionsCount: number;
  consecutiveLosses: number;
}

export interface CheckRiskArgs {
  decision: { id: string; verdict: Verdict };
  strategy: Strategy;
  symbol: string;
  mode: TradingMode;
}

async function gatherState(args: CheckRiskArgs): Promise<GatheredState> {
  const snap = await getLatestSnapshot();
  const exposure = await getExposure(args.mode, args.symbol);
  const consecutiveLosses = await getConsecutiveLosses(args.mode, args.strategy.id);
  const dailyPnl = await getDailyRealizedPnl(args.mode);
  return {
    equity: snap?.equity ?? DEFAULT_SIM_STARTING_EQUITY,
    drawdownPct: snap?.drawdown ?? 0,
    dailyPnl,
    openNotionalTotal: exposure.openNotionalTotal,
    openNotionalSymbol: exposure.openNotionalSymbol,
    openPositionsCount: exposure.openPositionsCount,
    consecutiveLosses,
  };
}

// Wrapper DB de check_risk: reúne el estado (o lo recibe inyectado en tests), evalúa y persiste.
export async function checkRiskForDecision(args: CheckRiskArgs, injected?: GatheredState): Promise<RiskResult> {
  const state = injected ?? (await gatherState(args));
  const result = evaluateRisk({
    verdict: args.decision.verdict,
    riskParams: parseRiskParams(args.strategy.riskParams),
    ...state,
  });
  await insertRiskEvaluation(args.decision.id, result);
  return result;
}
