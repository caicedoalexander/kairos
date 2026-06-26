import { describe, test, expect } from 'vitest';
import { buildDeterministicVerdict } from './verdict.ts';
import type { Signal, Strategy, Features } from '../scanner/types.ts';

function makeStrategy(riskParams: Record<string, unknown>): Strategy {
  return {
    id: 's', enabled: true, symbols: ['BTC/USDT'],
    triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } },
    riskParams, version: 1, skillName: null,
  };
}
function makeSignal(trigger: Partial<Features>): Signal {
  const f: Features = {
    close: 0, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null,
    stochRsi: null, atrPct: null, bbPosition: null, aboveVwap: null, obv: null, mfi: null,
    nearestSupport: null, nearestResistance: null, distToSupportPct: null, ...trigger,
  };
  return {
    strategyId: 's', symbol: 'BTC/USDT', firedAt: new Date('2026-03-01T00:00:00Z'),
    snapshot: { byTimeframe: { '15m': f }, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } },
  };
}
const RP = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 10, max_total_exposure_pct: 30, max_open_positions: 3, max_symbol_exposure_pct: 15, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };

describe('buildDeterministicVerdict', () => {
  test('enter: deriva SL del stop ATR y TP del R-múltiplo', () => {
    // close=100, atrPct=2 → atrAbs=2, stopDistance=1.5*2=3 → sl=97, tp=100+2*3=106
    const v = buildDeterministicVerdict(makeSignal({ close: 100, atrPct: 2 }), makeStrategy(RP));
    expect(v).toMatchObject({ action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1 });
  });
  test('skip cuando atrPct es null', () => {
    expect(buildDeterministicVerdict(makeSignal({ close: 100, atrPct: null }), makeStrategy(RP)).action).toBe('skip');
  });
  test('skip cuando entry ≤ 0', () => {
    expect(buildDeterministicVerdict(makeSignal({ close: 0, atrPct: 2 }), makeStrategy(RP)).action).toBe('skip');
  });
});
