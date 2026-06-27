import { ulid } from 'ulidx';
import { query } from '../pool.ts';
import type { SimParams } from '../../lib/execution/types.ts';

export interface InsertBacktestRunInput {
  strategyId: string;
  strategyVersion: number;
  symbol: string;
  window: { from: Date; to: Date };
  mode: 'det' | 'llm';
  simParams: SimParams;
  metrics: Record<string, unknown>;
  trades: unknown[];
}

export async function insertBacktestRun(p: InsertBacktestRunInput): Promise<string> {
  const id = ulid();
  await query(
    `INSERT INTO kairos.backtest_runs
       (id, strategy_id, strategy_version, symbol, "window", mode, sim_params, metrics, trades)
     VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[]'), $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
    [id, p.strategyId, p.strategyVersion, p.symbol, p.window.from, p.window.to, p.mode,
     JSON.stringify(p.simParams), JSON.stringify(p.metrics), JSON.stringify(p.trades)],
  );
  return id;
}

export interface BacktestRunRow {
  id: string;
  strategyId: string;
  strategyVersion: number;
  symbol: string;
  mode: string;
  metrics: Record<string, unknown>;
  trades: unknown[];
}

export async function getBacktestRun(id: string): Promise<BacktestRunRow | null> {
  const rows = await query<{
    id: string; strategy_id: string; strategy_version: number;
    symbol: string; mode: string; metrics: Record<string, unknown>; trades: unknown[];
  }>(
    `SELECT id, strategy_id, strategy_version, symbol, mode, metrics, trades
       FROM kairos.backtest_runs WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r
    ? { id: r.id, strategyId: r.strategy_id, strategyVersion: r.strategy_version,
        symbol: r.symbol, mode: r.mode, metrics: r.metrics, trades: r.trades }
    : null;
}
