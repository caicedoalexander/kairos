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
  entryFee?: number;     // SP6: fee de entrada (default 0 para llamadores legacy/tests)
  decisionId?: string;   // SP6: link a la decisión (legs OCO + reconciler)
}

export interface Exposure {
  openNotionalTotal: number;
  openNotionalSymbol: number;
  openPositionsCount: number;
}

export async function openPosition(p: OpenPositionInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, entry_fee, decision_id)
     VALUES ($1, $2, 'long', $3, $4, $5, $6, 'open', $7, $8, $9, $10)`,
    [id, p.symbol, p.entry, p.size, p.sl, p.tp, p.strategyId, p.mode, p.entryFee ?? 0, p.decisionId ?? null],
  );
  return id;
}

/** @deprecated SP6: usa closeOpenPosition (idempotente) + closeBracketLegs para no dejar legs OCO huérfanas. */
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

export interface OpenPosition {
  id: string;
  symbol: string;
  strategyId: string;
  decisionId: string | null;
  entry: number;
  size: number;
  sl: number;
  tp: number;
  entryFee: number;
  triggerTimeframe: string;
  mode: TradingMode;
  openedAt: Date;        // SP6: límite inferior de velas que el monitor puede resolver (anti-look-ahead)
}

interface OpenPositionRow {
  id: string; symbol: string; strategy_id: string; decision_id: string | null;
  entry: string; size: string; sl: string; tp: string; entry_fee: string;
  trigger_timeframe: string; mode: string; opened_at: Date;
}

// Posiciones abiertas del modo, con el trigger-TF de su estrategia (lo necesita el monitor para
// leer la última vela) y opened_at (para no salir en la vela de entrada). Filtra sl/tp NULL (sin
// bracket no hay nada que resolver) y estrategias sin trigger-TF (no se podrían monitorizar).
export async function getOpenPositions(mode: TradingMode, exec: Executor = query): Promise<OpenPosition[]> {
  const rows = await exec<OpenPositionRow>(
    `SELECT p.id, p.symbol, p.strategy_id, p.decision_id, p.entry, p.size, p.sl, p.tp, p.entry_fee, p.mode, p.opened_at,
            s.trigger_config->'timeframes'->>'trigger' AS trigger_timeframe
       FROM kairos.positions p
       JOIN kairos.strategies s ON s.id = p.strategy_id
      WHERE p.status = 'open' AND p.mode = $1 AND p.sl IS NOT NULL AND p.tp IS NOT NULL
        AND s.trigger_config->'timeframes'->>'trigger' IS NOT NULL`,
    [mode],
  );
  return rows.map((r) => ({
    id: r.id, symbol: r.symbol, strategyId: r.strategy_id, decisionId: r.decision_id,
    entry: Number(r.entry), size: Number(r.size), sl: Number(r.sl), tp: Number(r.tp),
    entryFee: Number(r.entry_fee), triggerTimeframe: r.trigger_timeframe, mode: r.mode as TradingMode,
    openedAt: r.opened_at,
  }));
}

// Pre-check de dedup per-setup: ¿hay ya una posición viva para (strategy, symbol, mode)?
export async function hasOpenPositionForSetup(
  strategyId: string, symbol: string, mode: TradingMode, exec: Executor = query,
): Promise<boolean> {
  const rows = await exec(
    `SELECT 1 FROM kairos.positions WHERE strategy_id = $1 AND symbol = $2 AND mode = $3 AND status = 'open' LIMIT 1`,
    [strategyId, symbol, mode],
  );
  return rows.length > 0;
}

// Cierre idempotente: solo aplica si sigue 'open'. Devuelve true si cerró la fila.
export async function closeOpenPosition(
  id: string, realizedPnl: number, closedAt: Date, exec: Executor = query,
): Promise<boolean> {
  const rows = await exec(
    `UPDATE kairos.positions SET status = 'closed', realized_pnl = $2, closed_at = $3
      WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, realizedPnl, closedAt],
  );
  return rows.length > 0;
}
