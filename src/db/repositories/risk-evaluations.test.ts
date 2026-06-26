import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { insertRiskEvaluation } from './risk-evaluations.ts';
import type { Signal } from '../../lib/scanner/types.ts';

const SYMBOL = 'RISKEVALBTC/USDT';
const STRATEGY_ID = 'riskeval-test-strategy';

async function seedDecision(): Promise<string> {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-03T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const { id } = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return id;
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('insertRiskEvaluation', () => {
  test('persiste el veredicto de check_risk ligado a la decision', async () => {
    const decisionId = await seedDecision();
    const id = await insertRiskEvaluation(decisionId, { result: 'allow', reason: 'ok', adjustedSize: 20, notional: 2000, limitsSnapshot: { equity: 10000 } });
    const rows = await query<{ result: string; adjusted_size: string }>('SELECT result, adjusted_size FROM kairos.risk_evaluations WHERE id = $1', [id]);
    expect(rows[0].result).toBe('allow');
    expect(Number(rows[0].adjusted_size)).toBe(20);
  });
});
