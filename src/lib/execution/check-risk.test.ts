import { describe, test, expect } from 'vitest';
import { evaluateRisk } from './check-risk.ts';
import type { RiskInput, RiskParams, Verdict } from './types.ts';

const RP: RiskParams = { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 50, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const V: Verdict = { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 };
function input(over: Partial<RiskInput> = {}): RiskInput {
  return { verdict: V, riskParams: RP, equity: 10000, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, dailyPnl: 0, drawdownPct: 0, consecutiveLosses: 0, ...over };
}

describe('evaluateRisk', () => {
  test('allow con size capado por riesgo', () => {
    const r = evaluateRisk(input());
    expect(r.result).toBe('allow');
    expect(r.adjustedSize).toBe(20);   // riskAmount 100 / stop 5
  });
  test('deny por drawdown (kill-switch)', () => {
    expect(evaluateRisk(input({ drawdownPct: 15 })).result).toBe('deny');
  });
  test('deny por pérdida diaria', () => {
    expect(evaluateRisk(input({ dailyPnl: -300 })).result).toBe('deny');  // -3% de 10000
  });
  test('deny por pérdidas consecutivas', () => {
    expect(evaluateRisk(input({ consecutiveLosses: 4 })).result).toBe('deny');
  });
  test('deny por concurrencia', () => {
    expect(evaluateRisk(input({ openPositionsCount: 3 })).result).toBe('deny');
  });
  test('cap notional reduce el size', () => {
    const r = evaluateRisk(input({ riskParams: { ...RP, max_notional_pct: 10 } }));
    expect(r.adjustedSize).toBe(10);   // maxNotional 1000 / entry 100
    expect(r.notional).toBe(1000);
  });
  test('deny por exposición total agotada', () => {
    const r = evaluateRisk(input({ openNotionalTotal: 10000, riskParams: { ...RP, max_total_exposure_pct: 50 } }));
    expect(r.result).toBe('deny');     // remaining 5000-10000 < 0
  });
  test('deny por notional bajo el mínimo', () => {
    expect(evaluateRisk(input({ equity: 10 })).result).toBe('deny');  // notional 2 < MIN_NOTIONAL 10
  });
});
