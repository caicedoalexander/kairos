import { ulid } from 'ulidx';
import { query } from '../pool.ts';
import type { Signal } from '../../lib/scanner/types.ts';

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
