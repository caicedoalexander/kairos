import { ulid } from 'ulidx';
import { query } from '../pool.ts';
import type { Signal, IndicatorSnapshot } from '../../lib/scanner/types.ts';

interface SignalRow {
  strategy_id: string;
  symbol: string;
  fired_at: Date;
  indicator_snapshot: IndicatorSnapshot;
}

// Recarga un Signal completo a partir de su id (para el worker de SP5).
export async function getSignalById(id: string): Promise<Signal | null> {
  const rows = await query<SignalRow>(
    `SELECT strategy_id, symbol, fired_at, indicator_snapshot
     FROM kairos.signals WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return { strategyId: r.strategy_id, symbol: r.symbol, firedAt: new Date(r.fired_at), snapshot: r.indicator_snapshot };
}

// Append-first: una señal disparada se inserta, nunca se actualiza (§8).
export async function insertSignal(signal: Signal): Promise<string> {
  const id = ulid();
  await query(
    `INSERT INTO kairos.signals (id, strategy_id, symbol, fired_at, indicator_snapshot, status)
     VALUES ($1, $2, $3, $4, $5, 'fired')`,
    [id, signal.strategyId, signal.symbol, signal.firedAt, JSON.stringify(signal.snapshot)],
  );
  return id;
}
