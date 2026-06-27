import { getStrategy } from '../../db/repositories/strategies.ts';
import { insertBacktestRun } from '../../db/repositories/backtest-runs.ts';
import { loadDataSource } from './data-source.ts';
import { runReplay } from './replay-driver.ts';
import { computeMetrics } from './metrics.ts';
import { DEFAULT_SIM_PARAMS, DEFAULT_SIM_STARTING_EQUITY } from '../execution/limits.ts';
import type { BacktestConfig, BacktestResult } from './types.ts';

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const strategy = await getStrategy(cfg.strategyId);
  if (!strategy) throw new Error(`estrategia no encontrada: ${cfg.strategyId}`);

  const simParams = cfg.simParams ?? DEFAULT_SIM_PARAMS;
  const startingEquity = cfg.startingEquity ?? DEFAULT_SIM_STARTING_EQUITY;

  const ds = await loadDataSource(strategy, cfg.symbol, cfg.window);
  if (ds.triggerCandles.length === 0) {
    throw new Error(`ventana sin velas trigger para ${cfg.symbol}; ¿falta backfill?`);
  }

  const { trades, equityCurve } = runReplay(strategy, cfg.symbol, ds, { startingEquity, simParams });

  const first = ds.triggerCandles[0];
  const last = ds.triggerCandles[ds.triggerCandles.length - 1];
  // Buy&hold con las mismas fees de sim (spec §3.4): comprar al open inicial, vender al close final.
  const bhFee = simParams.fee_bps / 1e4;
  const metrics = computeMetrics({
    trades, equityCurve, startingEquity,
    buyHold: { entryPrice: first.o * (1 + bhFee), exitPrice: last.c * (1 - bhFee) },
    window: cfg.window,
  });

  const runId = await insertBacktestRun({
    strategyId: strategy.id, strategyVersion: strategy.version, symbol: cfg.symbol,
    window: cfg.window, mode: 'det', simParams,
    metrics: metrics as unknown as Record<string, unknown>,
    trades: trades as unknown[],
  });

  return { runId, symbol: cfg.symbol, metrics, trades, equityCurve };
}
