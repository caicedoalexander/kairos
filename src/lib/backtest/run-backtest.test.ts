import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { getBacktestRun } from '../../db/repositories/backtest-runs.ts';
import { runBacktest } from './run-backtest.ts';
import type { OhlcvRow } from '../market-data/types.ts';

const SYMBOL = 'RUNBT/USDT';
const STRATEGY_ID = 'runbt-strategy';
const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const RISK = { risk_per_trade_pct: 1, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 100, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 50, max_drawdown_pct: 90, max_consecutive_losses: 99 };
const TRIGGER_CONFIG = { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] }, allow_counter: true };

const WINDOW_FROM = new Date('2024-03-01T00:00:00Z');
const WINDOW_TO = new Date('2024-03-04T00:00:00Z');

// Velas con una subida suave (ATR>0, EMA alcista) para que scan dispare y el precio alcance el TP.
function gen(tf: string, startMs: number, n: number, base: number, drift: number): OhlcvRow[] {
  return Array.from({ length: n }, (_, k) => {
    const c = base + k * drift;
    const openTime = new Date(startMs + k * TF_MS[tf]);
    return { symbol: SYMBOL, timeframe: tf, openTime, o: c, h: c + drift * 2, l: c - drift, c: c + drift, v: 100 };
  });
}

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, true, '15m', $2::text[], $3::jsonb, $4::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify(TRIGGER_CONFIG), JSON.stringify(RISK)],
  );
  for (const tf of ['15m', '1h', '4h']) {
    const preBars = 360; // > LOOKBACK
    const startMs = WINDOW_FROM.getTime() - preBars * TF_MS[tf];
    const total = preBars + Math.ceil((WINDOW_TO.getTime() - WINDOW_FROM.getTime()) / TF_MS[tf]) + 2;
    await upsertCandles(gen(tf, startMs, total, 100, 0.5));
  }
});
afterAll(async () => {
  await query(`DELETE FROM kairos.backtest_runs WHERE strategy_id = $1`, [STRATEGY_ID]);
  await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('runBacktest end-to-end (sim, det)', () => {
  test('produce trades, métricas y persiste backtest_runs', async () => {
    const res = await runBacktest({ strategyId: STRATEGY_ID, symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } });
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.equityCurve.length).toBeGreaterThan(0);
    expect(Number.isFinite(res.metrics.totalReturnPct)).toBe(true);
    const row = await getBacktestRun(res.runId);
    expect(row).not.toBeNull();
    expect(row!.symbol).toBe(SYMBOL);
    expect((row!.trades as unknown[]).length).toBe(res.trades.length);
  });

  test('reproducible: dos corridas → métricas idénticas', async () => {
    const a = await runBacktest({ strategyId: STRATEGY_ID, symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } });
    const b = await runBacktest({ strategyId: STRATEGY_ID, symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } });
    expect(b.metrics).toEqual(a.metrics);
    expect(b.trades.length).toBe(a.trades.length);
  });

  test('falla rápido si la estrategia no existe', async () => {
    await expect(runBacktest({ strategyId: 'no-existe', symbol: SYMBOL, window: { from: WINDOW_FROM, to: WINDOW_TO } }))
      .rejects.toThrow(/estrategia no encontrada/);
  });
});
