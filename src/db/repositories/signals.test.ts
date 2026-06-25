import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { seedStrategies } from '../seed-strategies.ts';
import { insertSignal } from './signals.ts';
import type { Signal } from '../../lib/scanner/types.ts';

beforeAll(async () => { await migrate(); await seedStrategies(); });
afterAll(async () => {
  await query("DELETE FROM kairos.signals WHERE symbol = 'TEST/USDT'", []);
  await pool.end();
});

const snapshot = { byTimeframe: {}, mtfAlignment: 'aligned' as const, levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } };

describe('signals repo', () => {
  test('insertSignal persiste y devuelve un ULID', async () => {
    const sig: Signal = { strategyId: 'pullback-alcista', symbol: 'TEST/USDT', firedAt: new Date('2026-03-01T00:00:00Z'), snapshot };
    const id = await insertSignal(sig);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const rows = await query<{ symbol: string; indicator_snapshot: { mtfAlignment: string } }>(
      'SELECT symbol, indicator_snapshot FROM kairos.signals WHERE id = $1', [id],
    );
    expect(rows[0]?.symbol).toBe('TEST/USDT');
    expect(rows[0]?.indicator_snapshot.mtfAlignment).toBe('aligned');
  });
});
