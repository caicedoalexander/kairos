import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { TradingMode } from '../../lib/mode.ts';

export interface OpenPositionInput {
  symbol: string;
  entry: number;
  size: number;
  sl: number;
  tp: number;
  strategyId: string;
  mode: TradingMode;
}

export interface Exposure {
  openNotionalTotal: number;
  openNotionalSymbol: number;
  openPositionsCount: number;
}

export async function openPosition(p: OpenPositionInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode)
     VALUES ($1, $2, 'long', $3, $4, $5, $6, 'open', $7, $8)`,
    [id, p.symbol, p.entry, p.size, p.sl, p.tp, p.strategyId, p.mode],
  );
  return id;
}

export async function closePosition(
  id: string,
  realizedPnl: number,
  closedAt: Date,
  exec: Executor = query,
): Promise<void> {
  await exec(
    `UPDATE kairos.positions SET status = 'closed', realized_pnl = $2, closed_at = $3 WHERE id = $1`,
    [id, realizedPnl, closedAt],
  );
}

export async function getExposure(
  mode: TradingMode,
  symbol: string,
  exec: Executor = query,
): Promise<Exposure> {
  const rows = await exec<{ total: string; symbol_total: string; cnt: string }>(
    `SELECT COALESCE(SUM(entry * size), 0) AS total,
            COALESCE(SUM(entry * size) FILTER (WHERE symbol = $2), 0) AS symbol_total,
            COUNT(*) AS cnt
       FROM kairos.positions
      WHERE status = 'open' AND mode = $1`,
    [mode, symbol],
  );
  const r = rows[0];
  return {
    openNotionalTotal: Number(r?.total ?? 0),
    openNotionalSymbol: Number(r?.symbol_total ?? 0),
    openPositionsCount: Number(r?.cnt ?? 0),
  };
}

// Racha de cierres con realized_pnl<0 más reciente (por estrategia). Se rompe en el primer no-perdedor.
export async function getConsecutiveLosses(
  mode: TradingMode,
  strategyId: string,
  exec: Executor = query,
): Promise<number> {
  const rows = await exec<{ realized_pnl: string }>(
    `SELECT realized_pnl FROM kairos.positions
      WHERE status = 'closed' AND mode = $1 AND strategy_id = $2
      ORDER BY closed_at DESC, id DESC`,
    [mode, strategyId],
  );
  let streak = 0;
  for (const r of rows) {
    if (Number(r.realized_pnl) < 0) streak += 1;
    else break;
  }
  return streak;
}

// P&L realizado del día UTC (account-level). Suma cierres desde las 00:00 UTC del día actual.
export async function getDailyRealizedPnl(
  mode: TradingMode,
  exec: Executor = query,
): Promise<number> {
  const rows = await exec<{ pnl: string }>(
    `SELECT COALESCE(SUM(realized_pnl), 0) AS pnl FROM kairos.positions
      WHERE status = 'closed' AND mode = $1
        AND closed_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [mode],
  );
  return Number(rows[0]?.pnl ?? 0);
}
