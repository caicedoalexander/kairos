import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { upsertFundingRates, getLatestFundingTs, getFundingRange } from './funding-rates.ts';
import type { FundingRow } from '../../lib/market-data/types.ts';

const SYMBOL = 'TEST/USDT';
const row = (iso: string, rate: number): FundingRow => ({ symbol: SYMBOL, ts: new Date(iso), rate });

beforeAll(async () => { await migrate(); });
beforeEach(async () => { await query('DELETE FROM kairos.funding_rates WHERE symbol = $1', [SYMBOL]); });
afterAll(async () => {
  await query('DELETE FROM kairos.funding_rates WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('funding-rates repo', () => {
  test('upsert inserta y es idempotente por PK (symbol, ts)', async () => {
    const batch = [row('2026-01-01T00:00:00Z', 0.0001), row('2026-01-01T08:00:00Z', 0.0002)];
    expect(await upsertFundingRates(batch)).toBe(2);
    expect(await upsertFundingRates(batch)).toBe(0);
  });

  test('getLatestFundingTs devuelve null sin datos y luego el máximo', async () => {
    expect(await getLatestFundingTs(SYMBOL)).toBeNull();
    await upsertFundingRates([row('2026-01-01T00:00:00Z', 0.0001), row('2026-01-01T08:00:00Z', 0.0002)]);
    expect((await getLatestFundingTs(SYMBOL))?.toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });

  test('getFundingRange devuelve el rango ascendente convertido a number', async () => {
    await upsertFundingRates([row('2026-01-01T00:00:00Z', 0.0001), row('2026-01-01T08:00:00Z', 0.0002)]);
    const rows = await getFundingRange(SYMBOL, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T08:00:00Z'));
    expect(rows.map((r) => r.rate)).toEqual([0.0001, 0.0002]);
  });
});
