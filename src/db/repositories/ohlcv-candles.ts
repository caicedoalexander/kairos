import { query, type QueryParam } from '../pool.ts';
import type { OhlcvRow } from '../../lib/market-data/types.ts';

const COLS_PER_ROW = 8;
const CHUNK_ROWS = 500; // 500 × 8 = 4000 params, holgado bajo el límite de pg (65535)

// Upsert idempotente por PK (symbol, timeframe, open_time): re-ingestar no duplica (§15.3).
export async function upsertCandles(rows: OhlcvRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    inserted += await upsertChunk(rows.slice(i, i + CHUNK_ROWS));
  }
  return inserted;
}

async function upsertChunk(rows: OhlcvRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: QueryParam[] = [];
  rows.forEach((row, i) => {
    const b = i * COLS_PER_ROW;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
    params.push(row.symbol, row.timeframe, row.openTime, row.o, row.h, row.l, row.c, row.v);
  });
  // RETURNING 1: con DO NOTHING solo vuelven las filas realmente insertadas → length = conteo.
  const result = await query(
    `INSERT INTO kairos.ohlcv_candles (symbol, timeframe, open_time, o, h, l, c, v)
     VALUES ${values.join(', ')}
     ON CONFLICT (symbol, timeframe, open_time) DO NOTHING
     RETURNING 1`,
    params,
  );
  return result.length;
}

export async function getLatestOpenTime(symbol: string, timeframe: string): Promise<Date | null> {
  const rows = await query<{ open_time: Date | null }>(
    `SELECT max(open_time) AS open_time
       FROM kairos.ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2`,
    [symbol, timeframe],
  );
  return rows[0]?.open_time ?? null;
}

export async function getLatestCandle(
  symbol: string, timeframe: string, asOf: Date, minOpenTime?: Date,
): Promise<OhlcvRow | null> {
  const rows = await query<{
    symbol: string; timeframe: string; open_time: Date; o: string; h: string; l: string; c: string; v: string;
  }>(
    `SELECT symbol, timeframe, open_time, o, h, l, c, v
       FROM kairos.ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2 AND open_time <= $3
        AND ($4::timestamptz IS NULL OR open_time > $4)
      ORDER BY open_time DESC LIMIT 1`,
    [symbol, timeframe, asOf, minOpenTime ?? null],
  );
  const r = rows[0];
  if (!r) return null;
  return { symbol: r.symbol, timeframe: r.timeframe, openTime: r.open_time,
    o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) };
}

export async function getCandles(
  symbol: string, timeframe: string, from: Date, to: Date,
): Promise<OhlcvRow[]> {
  const rows = await query<{
    symbol: string; timeframe: string; open_time: Date;
    o: string; h: string; l: string; c: string; v: string;
  }>(
    `SELECT symbol, timeframe, open_time, o, h, l, c, v
       FROM kairos.ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2 AND open_time >= $3 AND open_time <= $4
      ORDER BY open_time ASC`,
    [symbol, timeframe, from, to],
  );
  // pg devuelve numeric como string → convertir a number.
  return rows.map((r) => ({
    symbol: r.symbol, timeframe: r.timeframe, openTime: r.open_time,
    o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v),
  }));
}
