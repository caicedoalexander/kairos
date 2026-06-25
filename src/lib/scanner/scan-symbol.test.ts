// src/lib/scanner/scan-symbol.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { seedStrategies } from '../../db/seed-strategies.ts';
import { upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { scanSymbol } from './scan-symbol.ts';
import type { OhlcvRow } from '../market-data/types.ts';
import type { Strategy } from './types.ts';

const SYMBOL = 'TEST/USDT';
const TF_MS: Record<string, number> = { '4h': 14_400_000, '1h': 3_600_000, '15m': 900_000 };
const AS_OF = new Date('2026-03-01T00:00:00Z');

// Genera 250 velas alcistas por TF terminando antes de AS_OF (cierres crecientes).
function bullishCandles(tf: string): OhlcvRow[] {
  const n = 250;
  return Array.from({ length: n }, (_, i) => {
    const openTime = new Date(AS_OF.getTime() - (n - i) * TF_MS[tf]);
    const c = 100 + i;
    return { symbol: SYMBOL, timeframe: tf, openTime, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 };
  });
}

beforeAll(async () => {
  await migrate();
  await seedStrategies();
  for (const tf of ['4h', '1h', '15m']) await upsertCandles(bullishCandles(tf));
});
afterAll(async () => {
  await query('DELETE FROM kairos.ohlcv_candles WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await pool.end();
});

describe('scanSymbol (integración)', () => {
  // Estrategia ad-hoc con el id de la semilla (FK válida en strategies) pero entry mínimo
  // garantizable: ema_stack_bullish sobre 250 velas alcistas SÍ dispara → assert duro del
  // criterio §10.5 (persistencia end-to-end), sin depender de near_support/rsi_cross_up.
  const simple: Strategy = {
    id: 'pullback-alcista', enabled: true, symbols: [SYMBOL], version: 1, riskParams: {},
    triggerConfig: {
      timeframes: { bias: '4h', context: '1h', trigger: '15m' },
      entry: { all: [{ tf: '4h', predicate: 'ema_stack_bullish' }] },
    },
  };

  test('end-to-end: velas alcistas → signal persistida (assert duro)', async () => {
    const id = await scanSymbol(simple, SYMBOL, AS_OF);
    expect(id).not.toBeNull();
    const rows = await query<{ symbol: string; indicator_snapshot: { mtfAlignment: string } }>(
      'SELECT symbol, indicator_snapshot FROM kairos.signals WHERE id = $1', [id],
    );
    expect(rows[0]?.symbol).toBe(SYMBOL);
    expect(rows[0]?.indicator_snapshot.mtfAlignment).toBe('aligned');
  });

  test('símbolo sin velas → null', async () => {
    expect(await scanSymbol(simple, 'SIN/DATOS', AS_OF)).toBeNull();
  });
});
