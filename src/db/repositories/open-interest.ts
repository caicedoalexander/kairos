import { query, type QueryParam } from '../pool.ts';
import type { OpenInterestRow } from '../../lib/market-data/types.ts';

const COLS_PER_ROW = 4;
const CHUNK_ROWS = 1000; // 1000 × 4 = 4000 params

// Upsert idempotente por PK (symbol, ts). OI del perp como señal read-only (§15).
export async function upsertOpenInterest(rows: OpenInterestRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    inserted += await upsertChunk(rows.slice(i, i + CHUNK_ROWS));
  }
  return inserted;
}

async function upsertChunk(rows: OpenInterestRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: QueryParam[] = [];
  rows.forEach((row, i) => {
    const b = i * COLS_PER_ROW;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
    params.push(row.symbol, row.ts, row.oi, row.oiValue);
  });
  const result = await query(
    `INSERT INTO kairos.open_interest (symbol, ts, oi, oi_value)
     VALUES ${values.join(', ')}
     ON CONFLICT (symbol, ts) DO NOTHING
     RETURNING 1`,
    params,
  );
  return result.length;
}

export async function getLatestOiTs(symbol: string): Promise<Date | null> {
  const rows = await query<{ ts: Date | null }>(
    `SELECT max(ts) AS ts FROM kairos.open_interest WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]?.ts ?? null;
}

export async function getOpenInterestRange(symbol: string, from: Date, to: Date): Promise<OpenInterestRow[]> {
  const rows = await query<{ symbol: string; ts: Date; oi: string; oi_value: string | null }>(
    `SELECT symbol, ts, oi, oi_value FROM kairos.open_interest
      WHERE symbol = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts ASC`,
    [symbol, from, to],
  );
  return rows.map((r) => ({
    symbol: r.symbol, ts: r.ts, oi: Number(r.oi),
    oiValue: r.oi_value === null ? null : Number(r.oi_value),
  }));
}
