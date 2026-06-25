import { query, type QueryParam } from '../pool.ts';
import type { FundingRow } from '../../lib/market-data/types.ts';

const COLS_PER_ROW = 3;
const CHUNK_ROWS = 1000; // 1000 × 3 = 3000 params

// Upsert idempotente por PK (symbol, ts). Funding del perp como señal read-only (§15).
export async function upsertFundingRates(rows: FundingRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    inserted += await upsertChunk(rows.slice(i, i + CHUNK_ROWS));
  }
  return inserted;
}

async function upsertChunk(rows: FundingRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: QueryParam[] = [];
  rows.forEach((row, i) => {
    const b = i * COLS_PER_ROW;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
    params.push(row.symbol, row.ts, row.rate);
  });
  const result = await query(
    `INSERT INTO kairos.funding_rates (symbol, ts, rate)
     VALUES ${values.join(', ')}
     ON CONFLICT (symbol, ts) DO NOTHING
     RETURNING 1`,
    params,
  );
  return result.length;
}

export async function getLatestFundingTs(symbol: string): Promise<Date | null> {
  const rows = await query<{ ts: Date | null }>(
    `SELECT max(ts) AS ts FROM kairos.funding_rates WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]?.ts ?? null;
}

export async function getFundingRange(symbol: string, from: Date, to: Date): Promise<FundingRow[]> {
  const rows = await query<{ symbol: string; ts: Date; rate: string }>(
    `SELECT symbol, ts, rate FROM kairos.funding_rates
      WHERE symbol = $1 AND ts >= $2 AND ts <= $3
      ORDER BY ts ASC`,
    [symbol, from, to],
  );
  return rows.map((r) => ({ symbol: r.symbol, ts: r.ts, rate: Number(r.rate) }));
}
