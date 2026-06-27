import { describe, test, expect } from 'vitest';
import { computeMetrics } from './metrics.ts';
import type { ClosedTrade, EquityPoint } from './types.ts';

const WIN: ClosedTrade = { openedAt: new Date('2024-01-01T00:00:00Z'), closedAt: new Date('2024-01-01T06:00:00Z'), entry: 100, exit: 110, size: 1, fees: 0.2, realizedPnl: 20, hitType: 'tp', rMultiple: 2 };
const LOSS: ClosedTrade = { openedAt: new Date('2024-01-02T00:00:00Z'), closedAt: new Date('2024-01-02T06:00:00Z'), entry: 100, exit: 95, size: 1, fees: 0.2, realizedPnl: -10, hitType: 'sl', rMultiple: -1 };

function curve(values: Array<[string, number]>): EquityPoint[] {
  return values.map(([t, equity]) => ({ t: new Date(t), equity }));
}

describe('computeMetrics', () => {
  test('trade stats: winRate, profitFactor, expectancy, payoff', () => {
    const m = computeMetrics({
      trades: [WIN, LOSS], startingEquity: 10000,
      equityCurve: curve([['2024-01-01T06:00:00Z', 10020], ['2024-01-02T06:00:00Z', 10010]]),
      buyHold: { entryPrice: 100, exitPrice: 105 },
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-03T00:00:00Z') },
    });
    expect(m.trades).toBe(2);
    expect(m.winRate).toBeCloseTo(50, 6);
    expect(m.profitFactor).toBeCloseTo(2, 6);       // 20 / 10
    expect(m.expectancy).toBeCloseTo(5, 6);          // (20 - 10) / 2
    expect(m.avgWin).toBeCloseTo(20, 6);
    expect(m.avgLoss).toBeCloseTo(-10, 6);
    expect(m.payoffRatio).toBeCloseTo(2, 6);         // 20 / 10
    expect(m.buyHoldReturnPct).toBeCloseTo(5, 6);    // (105-100)/100
  });

  test('caso sin trades: stats neutros, sin NaN', () => {
    const m = computeMetrics({
      trades: [], startingEquity: 10000,
      equityCurve: curve([['2024-01-01T00:00:00Z', 10000], ['2024-01-02T00:00:00Z', 10000]]),
      buyHold: { entryPrice: 100, exitPrice: 100 },
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-02T00:00:00Z') },
    });
    expect(m.trades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.profitFactor).toBeNull();
    expect(m.payoffRatio).toBeNull();
    expect(Number.isNaN(m.sharpe)).toBe(false);
    expect(m.maxDrawdownPct).toBe(0);
  });

  test('maxDrawdown sobre la curva de equity', () => {
    const m = computeMetrics({
      trades: [], startingEquity: 100,
      equityCurve: curve([
        ['2024-01-01T00:00:00Z', 100], ['2024-01-02T00:00:00Z', 120],
        ['2024-01-03T00:00:00Z', 90], ['2024-01-04T00:00:00Z', 130],
      ]),
      buyHold: { entryPrice: 1, exitPrice: 1 },
      window: { from: new Date('2024-01-01T00:00:00Z'), to: new Date('2024-01-04T00:00:00Z') },
    });
    // pico 120 → valle 90 → DD = (120-90)/120 = 25%
    expect(m.maxDrawdownPct).toBeCloseTo(25, 6);
  });
});
