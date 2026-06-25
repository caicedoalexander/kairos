import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { upsertOpenInterest, getLatestOiTs, getOpenInterestRange } from './open-interest.ts';
import type { OpenInterestRow } from '../../lib/market-data/types.ts';

const SYMBOL = 'TEST/USDT';
const row = (iso: string, oi: number, oiValue: number | null): OpenInterestRow =>
  ({ symbol: SYMBOL, ts: new Date(iso), oi, oiValue });

beforeAll(async () => { await migrate(); });
beforeEach(async () => { await query('DELETE FROM kairos.open_interest WHERE symbol = $1', [SYMBOL]); });
afterAll(async () => {
  await query('DELETE FROM kairos.open_interest WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('open-interest repo', () => {
  test('upsert inserta y es idempotente por PK (symbol, ts)', async () => {
    const batch = [row('2026-01-01T00:00:00Z', 500, 1_000_000), row('2026-01-01T00:05:00Z', 510, null)];
    expect(await upsertOpenInterest(batch)).toBe(2);
    expect(await upsertOpenInterest(batch)).toBe(0);
  });

  test('persiste oiValue null y lo devuelve', async () => {
    await upsertOpenInterest([row('2026-01-01T00:00:00Z', 500, null)]);
    const rows = await getOpenInterestRange(SYMBOL, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:05:00Z'));
    expect(rows[0].oi).toBe(500);
    expect(rows[0].oiValue).toBeNull();
  });

  test('getLatestOiTs devuelve el máximo', async () => {
    await upsertOpenInterest([row('2026-01-01T00:00:00Z', 500, 1), row('2026-01-01T00:05:00Z', 510, 2)]);
    expect((await getLatestOiTs(SYMBOL))?.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });
});
