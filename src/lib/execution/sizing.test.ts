import { describe, test, expect } from 'vitest';
import { computeSize } from './sizing.ts';
import type { Verdict, RiskParams } from './types.ts';

const RP = { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 100, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 } as RiskParams;
const V: Verdict = { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 };

describe('computeSize', () => {
  test('el riesgo manda sobre el tamaño', () => {
    // equity=10000, riskPct=1 → riskAmount=100; stopDistance=5 → size=20; notional=2000
    expect(computeSize(10000, V, RP)).toMatchObject({ riskAmount: 100, stopDistance: 5, size: 20, notional: 2000 });
  });
  test('aplica el techo MAX_RISK_PER_TRADE', () => {
    // risk_per_trade_pct=5 pero techo=2 → riskAmount=200; size=40
    const s = computeSize(10000, V, { ...RP, risk_per_trade_pct: 5 });
    expect(s.riskAmount).toBe(200);
    expect(s.size).toBe(40);
  });
  test('sizingFactor reduce el tamaño', () => {
    expect(computeSize(10000, { ...V, sizingFactor: 0.5 }, RP).size).toBe(10);
  });
});
