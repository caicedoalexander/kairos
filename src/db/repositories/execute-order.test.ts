import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { executeOrderSim } from '../../lib/execution/execute-order.ts';
import { DEFAULT_SIM_PARAMS } from '../../lib/execution/limits.ts';
import type { Signal, Strategy } from '../../lib/scanner/types.ts';
import type { RiskResult } from '../../lib/execution/types.ts';

const SYMBOL = 'EXECBTC/USDT';
const STRATEGY_ID = 'exec-test-strategy';

const STRATEGY: Strategy = {
  id: STRATEGY_ID, enabled: true, symbols: [SYMBOL],
  triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } },
  riskParams: {}, version: 1, skillName: null,
};
const RISK_ALLOW: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 1, notional: 100, limitsSnapshot: {} };

async function seedSignalAndDecision() {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-05T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return { signalId, decision };
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id = o.decision_id JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('executeOrderSim', () => {
  test('abre una posición y el fill es peor que el referencePrice', async () => {
    const { signalId, decision } = await seedSignalAndDecision();
    const r = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(r.status).toBe('filled');
    expect(r.positionId).not.toBeNull();
    expect(r.fillPrice!).toBeGreaterThan(100);   // peor que mid en buy
  });

  test('idempotencia: repetir con el mismo signalId no duplica la posición', async () => {
    const { signalId, decision } = await seedSignalAndDecision();
    const before = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol = $1 AND mode = 'sim'`, [SYMBOL]);
    const first = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    const second = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(first.status).toBe('filled');
    expect(second.status).toBe('duplicate');
    expect(second.orderId).toBe(first.orderId);
    const after = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol = $1 AND mode = 'sim'`, [SYMBOL]);
    expect(Number(after[0].n)).toBe(Number(before[0].n) + 1);
  });
});
