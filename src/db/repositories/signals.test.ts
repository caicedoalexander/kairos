import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { seedStrategies } from '../seed-strategies.ts';
import { insertSignal, getSignalById } from './signals.ts';
import type { Signal } from '../../lib/scanner/types.ts';

beforeAll(async () => { await migrate(); await seedStrategies(); });
afterAll(async () => {
  await query("DELETE FROM kairos.signals WHERE symbol = 'TEST/USDT'", []);
  await pool.end();
});

const snapshot = { byTimeframe: {}, mtfAlignment: 'aligned' as const, levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } };

describe('getSignalById', () => {
  const snap15m = {
    byTimeframe: { '15m': { close: 100, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null, stochRsi: null, atrPct: 2, bbPosition: null, aboveVwap: null, obv: null, mfi: null, nearestSupport: null, nearestResistance: null, distToSupportPct: null } },
    mtfAlignment: 'aligned' as const, levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null },
  };

  test('reconstruye el Signal persistido (firedAt como Date, snapshot intacto)', async () => {
    const id = await insertSignal({ strategyId: 'pullback-alcista', symbol: 'TEST/USDT', firedAt: new Date('2026-03-07T00:00:00Z'), snapshot: snap15m });
    const loaded = await getSignalById(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.symbol).toBe('TEST/USDT');
    expect(loaded!.firedAt).toBeInstanceOf(Date);
    expect(loaded!.firedAt.toISOString()).toBe('2026-03-07T00:00:00.000Z');
    expect(loaded!.snapshot.byTimeframe['15m'].close).toBe(100);
    expect(loaded!.snapshot.mtfAlignment).toBe('aligned');
  });

  test('devuelve null si el id no existe', async () => {
    expect(await getSignalById('00000000000000000000000000')).toBeNull();
  });
});

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
