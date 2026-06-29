import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { insertShadowVerdict, isAlreadyEvaluated, getShadowVerdict } from './shadow-verdicts.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'SHADOWBTC/USDT';
const STRATEGY_ID = 'shadow-test-strategy';

async function seedSignal(): Promise<string> {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`, [STRATEGY_ID, `{${SYMBOL}}`]);
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-20T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  return insertSignal(signal);
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.shadow_verdicts WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('shadow_verdicts repo', () => {
  test('insert + get round-trip; isAlreadyEvaluated', async () => {
    const signalId = await seedSignal();
    expect(await isAlreadyEvaluated(signalId)).toBe(false);
    await insertShadowVerdict({
      signalId, verdict: { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' },
      confianza: 'media', razonamiento: 'x', modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 1234,
      technicalRead: { bias: 'bullish', confluence: 'strong', regime: 'trending', divergence: 'none', mtfNote: 'm', notes: 'n' },
      technicalModel: 'anthropic/claude-haiku-4-5', technicalTokens: 321,
    });
    expect(await isAlreadyEvaluated(signalId)).toBe(true);
    const row = await getShadowVerdict(signalId);
    expect(row?.modelUsed).toBe('anthropic/claude-sonnet-4-6');
    expect(row?.tokens).toBe(1234);
    expect((row?.verdict as { action: string }).action).toBe('enter');
    expect((row?.technicalRead as { bias: string }).bias).toBe('bullish');
    expect(row?.technicalModel).toBe('anthropic/claude-haiku-4-5');
    expect(row?.technicalTokens).toBe(321);
  });

  test('analista degradado: technical_* null se persiste y se lee como null', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict({
      signalId, verdict: {}, confianza: 'baja', razonamiento: null, modelUsed: 'm', tokens: null,
      technicalRead: null, technicalModel: null, technicalTokens: null,
    });
    const row = await getShadowVerdict(signalId);
    expect(row?.technicalRead).toBeNull();
    expect(row?.technicalModel).toBeNull();
    expect(row?.technicalTokens).toBeNull();
  });

  test('ON CONFLICT DO NOTHING: reinsertar la misma señal no duplica ni lanza', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict({ signalId, verdict: {}, confianza: 'alta', razonamiento: null, modelUsed: 'm', tokens: null,
      technicalRead: null, technicalModel: null, technicalTokens: null });
    await insertShadowVerdict({ signalId, verdict: {}, confianza: 'baja', razonamiento: null, modelUsed: 'm2', tokens: null,
      technicalRead: null, technicalModel: null, technicalTokens: null });
    const rows = await query(`SELECT confianza FROM kairos.shadow_verdicts WHERE signal_id=$1`, [signalId]);
    expect(rows.length).toBe(1);
    expect((rows[0] as { confianza: string }).confianza).toBe('alta'); // la primera gana
  });
});
