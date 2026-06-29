import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { insertShadowVerdict } from './shadow-verdicts.ts';
import { persistDecision } from './decisions.ts';
import { getShadowVsDeterministic } from './shadow-report-query.ts';
import type { Signal } from '../../lib/scanner/types.ts';
import type { Verdict } from '../../lib/execution/types.ts';

const SYMBOL = 'ABREPORTBTC/USDT';
const STRATEGY_ID = 'abreport-strategy';
const DET: Verdict = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.6 };
const LLM = { action: 'enter' as const, entry: 100, sl: 97, tp: 106, sizingFactor: 0.4, confianza: 'media' as const, razonamiento: 'x' };

async function seedSignal(): Promise<string> {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`, [STRATEGY_ID, `{${SYMBOL}}`]);
  const s: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-06-29T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  return insertSignal(s);
}
function fullShadowRow(signalId: string) {
  return { signalId, verdict: LLM, confianza: 'media', razonamiento: 'x', modelUsed: 'm', tokens: 1,
    technicalRead: null, technicalModel: null, technicalTokens: null,
    fundamentalRead: null, fundamentalModel: null, fundamentalTokens: null, fundamentalStatus: null, fundamentalFetchOk: null, escalated: false };
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.shadow_verdicts WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('getShadowVsDeterministic', () => {
  test('det enter (con decisión) + posición cerrada → detVerdict y realizedPnl presentes', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict(fullShadowRow(signalId));
    const dec = await persistDecision(signalId, DET);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, realized_pnl, strategy_id, mode, decision_id, closed_at)
                 VALUES ('pos-abreport', $1, 'long', 100, 1, 97, 106, 'closed', 12.5, $2, 'sim', $3, now())`, [SYMBOL, STRATEGY_ID, dec.id]);
    const rows = (await getShadowVsDeterministic()).filter((r) => r.signalId === signalId);
    expect(rows).toHaveLength(1);
    expect(rows[0].detVerdict?.action).toBe('enter');
    expect(rows[0].llmVerdict.sizingFactor).toBe(0.4);
    expect(rows[0].positionClosed).toBe(true);
    expect(rows[0].realizedPnl).toBe(12.5);
  });

  test('det skip (sin decisión) → detVerdict null, sin posición', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict(fullShadowRow(signalId));
    const rows = (await getShadowVsDeterministic()).filter((r) => r.signalId === signalId);
    expect(rows).toHaveLength(1);
    expect(rows[0].detVerdict).toBeNull();
    expect(rows[0].positionClosed).toBe(false);
    expect(rows[0].realizedPnl).toBeNull();
  });

  test('det enter con posición ABIERTA (aún en curso) → detVerdict presente, positionClosed false, realizedPnl null', async () => {
    const signalId = await seedSignal();
    await insertShadowVerdict(fullShadowRow(signalId));
    const dec = await persistDecision(signalId, DET);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, realized_pnl, strategy_id, mode, decision_id)
                 VALUES ('pos-abreport-open', $1, 'long', 100, 1, 97, 106, 'open', 0, $2, 'sim', $3)`, [SYMBOL, STRATEGY_ID, dec.id]);
    const rows = (await getShadowVsDeterministic()).filter((r) => r.signalId === signalId);
    expect(rows).toHaveLength(1);
    expect(rows[0].detVerdict?.action).toBe('enter');
    expect(rows[0].positionClosed).toBe(false);
    expect(rows[0].realizedPnl).toBeNull();
  });
});
