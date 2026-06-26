import { MAX_RISK_PER_TRADE } from './limits.ts';
import type { Verdict, RiskParams, SizeBreakdown } from './types.ts';

// Sizing fijo-fraccional + stop ATR (§19.1). El riesgo manda sobre el tamaño.
export function computeSize(equity: number, verdict: Verdict, riskParams: RiskParams): SizeBreakdown {
  const riskPct = Math.min(riskParams.risk_per_trade_pct, MAX_RISK_PER_TRADE); // techo duro
  const riskAmount = equity * (riskPct / 100);
  const stopDistance = verdict.entry - verdict.sl;          // > 0 en veredicto 'enter'
  const size = (riskAmount / stopDistance) * verdict.sizingFactor;
  const notional = size * verdict.entry;
  return { size, notional, riskAmount, stopDistance };
}
