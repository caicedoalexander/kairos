import { describe, test, expect } from 'vitest';
import { runReplay } from './replay-driver.ts';
import type { BacktestDataSource } from './data-source.ts';
import type { Strategy, CandlesByTimeframe, Candle } from '../scanner/types.ts';

const SYMBOL = 'RPL/USDT';
const TRIGGER_MS = 900_000; // 15m
const SIM = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 };
const SNAP_N = 260;                 // > REQUIRED_WARMUP (200)
const B0 = SNAP_N * TRIGGER_MS;     // openTime de la primera barra trigger de ejecución

const STRATEGY: Strategy = {
  id: 'rpl-strategy', enabled: true, symbols: [SYMBOL],
  triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] }, allow_counter: true },
  riskParams: { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 100, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 50, max_drawdown_pct: 90, max_consecutive_losses: 99 },
  version: 1, skillName: null,
};

function bar(openMs: number, o: number, h: number, l: number, c: number): Candle {
  return { symbol: SYMBOL, timeframe: '15m', openTime: new Date(openMs), o, h, l, c, v: 100 };
}

// 260 velas bullish suaves (close 50 → 101.8) → emaStack bullish + ATR>0. Misma serie para los 3 TFs.
function bullish(tf: string): Candle[] {
  return Array.from({ length: SNAP_N }, (_, k) => {
    const c = 50 + k * 0.2;
    return { symbol: SYMBOL, timeframe: tf, openTime: new Date(k * TRIGGER_MS), o: c - 0.1, h: c + 0.4, l: c - 0.4, c, v: 100 };
  });
}
const SCANNABLE: CandlesByTimeframe = { '4h': bullish('4h'), '1h': bullish('1h'), '15m': bullish('15m') };

// closedCandlesAt SIEMPRE devuelve el snapshot bullish → scan dispara cuando no hay posición ni pending.
function signalDs(bars: Candle[]): BacktestDataSource {
  return {
    triggerCandles: bars,
    closeTimeAt: (i) => new Date(bars[i].openTime.getTime() + TRIGGER_MS),
    closedCandlesAt: () => SCANNABLE,
    derivativesAt: () => ({ fundingZ: null, oiChangePct: null }),
  };
}

describe('replay-driver', () => {
  test('sin señales (closedCandlesAt vacío) → 0 trades y equity plana', () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(TRIGGER_MS, 100, 101, 99, 100)];
    const flatDs: BacktestDataSource = {
      triggerCandles: bars,
      closeTimeAt: (i) => new Date(bars[i].openTime.getTime() + TRIGGER_MS),
      closedCandlesAt: () => ({ '4h': [], '1h': [], '15m': [] }),
      derivativesAt: () => ({ fundingZ: null, oiChangePct: null }),
    };
    const out = runReplay(STRATEGY, SYMBOL, flatDs, { startingEquity: 10000, simParams: SIM });
    expect(out.trades).toHaveLength(0);
    expect(out.equityCurve).toHaveLength(2);
    expect(out.equityCurve[0].equity).toBe(10000);
    expect(out.finalLedger.open).toBeNull();
  });

  test('señal en bar0 → entrada al open de bar1 → SL primero (low fuerza el stop)', () => {
    // bar0: dispara señal (verdict ancla ~101.8 del snapshot). bar1: entrada al open=101.8; low=2 ≤ sl.
    // bar0.close=100.0 deliberadamente distinto de bar1.open=101.8 para detectar look-ahead.
    const bars = [
      bar(B0, 100.0, 101.85, 99.0, 100.0),      // close=100.0; fill NO debe usar este precio
      bar(B0 + TRIGGER_MS, 101.8, 101.85, 2, 50),
    ];
    const out = runReplay(STRATEGY, SYMBOL, signalDs(bars), { startingEquity: 10000, simParams: SIM });
    expect(out.trades).toHaveLength(1);                 // si es 0, el snapshot no disparó scan → ajustar la serie
    expect(out.trades[0].hitType).toBe('sl');
    // fill al open de bar1 (101.8)+slippage, NO al close de bar0 (100.0): un look-ahead daría entry≈100.09 < 101.8
    expect(out.trades[0].entry).toBeGreaterThan(101.8); // fill peor que el open por slippage de compra
    expect(out.trades[0].rMultiple).toBeLessThan(0);
    expect(out.finalLedger.open).toBeNull();
  });

  test('posición abierta al final → cierre end-of-data al último close', () => {
    // bar1 (range estrecho en torno al entry) no toca SL ni TP → queda abierta → eod al close.
    const bars = [
      bar(B0, 101.8, 101.85, 101.75, 101.8),
      bar(B0 + TRIGGER_MS, 101.8, 101.85, 101.75, 101.82),
    ];
    const out = runReplay(STRATEGY, SYMBOL, signalDs(bars), { startingEquity: 10000, simParams: SIM });
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].hitType).toBe('eod');
    expect(out.trades[0].exit).toBeCloseTo(101.82, 6);
    // invariante: el último punto de la curva = equity realizada final (incluye la exitFee del cierre EOD)
    const fl = out.finalLedger;
    expect(out.equityCurve[out.equityCurve.length - 1].equity).toBeCloseTo(fl.startingEquity + fl.realized, 6);
  });
});
