import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { checkRiskForDecision, type GatheredState } from '../../lib/execution/check-risk.ts';
import type { Signal, Strategy } from '../../lib/scanner/types.ts';

const SYMBOL = 'RISKWBTC/USDT';
const STRATEGY_ID = 'riskw-test-strategy';
const RISK_PARAMS = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 10, max_total_exposure_pct: 30, max_open_positions: 3, max_symbol_exposure_pct: 15, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: RISK_PARAMS, version: 1, skillName: null };
const STATE: GatheredState = { equity: 100000, drawdownPct: 0, dailyPnl: 0, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, consecutiveLosses: 0 };

async function seedDecision(verdict = { action: 'enter' as const, entry: 100, sl: 97, tp: 106, sizingFactor: 1 }) {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-06T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  return persistDecision(signalId, verdict);
}

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)', [SYMBOL]);
  await query('DELETE FROM kairos.signals WHERE symbol = $1', [SYMBOL]);
  await query('DELETE FROM kairos.strategies WHERE id = $1', [STRATEGY_ID]);
  await pool.end();
});

describe('checkRiskForDecision', () => {
  test('con estado inyectado: allow y persiste risk_evaluations', async () => {
    const decision = await seedDecision();
    const result = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' }, STATE);
    expect(result.result).toBe('allow');
    const rows = await query<{ result: string }>('SELECT result FROM kairos.risk_evaluations WHERE decision_id = $1', [decision.id]);
    expect(rows[0]?.result).toBe('allow');
  });

  test('con estado inyectado: deny por drawdown', async () => {
    const decision = await seedDecision();
    const result = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' }, { ...STATE, drawdownPct: 20 });
    expect(result.result).toBe('deny');
  });

  test('sin inyección (lee de la DB): devuelve un enum válido y persiste (tolerante)', async () => {
    const decision = await seedDecision();
    const result = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' });
    expect(['allow', 'deny', 'needs_approval']).toContain(result.result);
    const rows = await query('SELECT 1 FROM kairos.risk_evaluations WHERE decision_id = $1', [decision.id]);
    expect(rows).toHaveLength(1);
  });
});
