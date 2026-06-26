import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { insertSignal } from './signals.ts';
import { persistDecision } from './decisions.ts';
import { closePosition } from './positions.ts';
import { buildDeterministicVerdict } from '../../lib/execution/verdict.ts';
import { checkRiskForDecision, type GatheredState } from '../../lib/execution/check-risk.ts';
import { executeOrderSim } from '../../lib/execution/execute-order.ts';
import { resolveBracket } from '../../lib/execution/bracket.ts';
import { DEFAULT_SIM_PARAMS } from '../../lib/execution/limits.ts';
import type { Signal, Strategy, Features } from '../../lib/scanner/types.ts';

const SYMBOL = 'E2EBTC/USDT';
const STRATEGY_ID = 'e2e-test-strategy';
const RISK_PARAMS = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 50, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: RISK_PARAMS, version: 2, skillName: null };
const STATE: GatheredState = { equity: 100000, drawdownPct: 0, dailyPnl: 0, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, consecutiveLosses: 0 };

function features(close: number, atrPct: number): Features {
  return { close, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null, stochRsi: null, atrPct, bbPosition: null, aboveVwap: null, obv: null, mfi: null, nearestSupport: null, nearestResistance: null, distToSupportPct: null };
}

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], '{}'::jsonb, '{}'::jsonb, 2) ON CONFLICT (id) DO NOTHING`,
    [STRATEGY_ID, `{${SYMBOL}}`],
  );
});
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id = o.decision_id JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id = d.signal_id WHERE s.symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol = $1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRATEGY_ID]);
  await pool.end();
});

describe('SP3 end-to-end (sim)', () => {
  test('signal → veredicto → check_risk(allow) → execute → cierre por TP', async () => {
    // 1. Signal con features del TF trigger (close=100, atrPct=2 → sl=97, tp=106).
    const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-07T00:00:00Z'),
      snapshot: { byTimeframe: { '15m': features(100, 2) }, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
    const signalId = await insertSignal(signal);

    // 2. Veredicto determinista.
    const verdict = buildDeterministicVerdict(signal, STRATEGY);
    expect(verdict).toMatchObject({ action: 'enter', entry: 100, sl: 97, tp: 106 });

    // 3. Persistir decision.
    const decision = await persistDecision(signalId, verdict);

    // 4. check_risk con estado inyectado (determinista) → allow.
    const riskResult = await checkRiskForDecision({ decision, strategy: STRATEGY, symbol: SYMBOL, mode: 'sim' }, STATE);
    expect(riskResult.result).toBe('allow');

    // 5. execute_order → posición abierta.
    const exec1 = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult, strategy: STRATEGY, referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(exec1.status).toBe('filled');
    expect(exec1.positionId).not.toBeNull();

    // 6. Idempotencia: repetir → duplicate, sigue 1 posición.
    const exec2 = await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult, strategy: STRATEGY, referencePrice: verdict.entry, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
    expect(exec2.status).toBe('duplicate');
    const cnt = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol = $1 AND mode = 'sim'`, [SYMBOL]);
    expect(Number(cnt[0].n)).toBe(1);

    // 7. Cierre por TP: leer la posición y su fee de entrada, resolver con una vela que toca TP.
    const posRows = await query<{ id: string; entry: string; size: string; sl: string; tp: string }>(`SELECT id, entry, size, sl, tp FROM kairos.positions WHERE symbol = $1 AND status = 'open'`, [SYMBOL]);
    const pos = posRows[0];
    const feeRows = await query<{ fee: string }>(`SELECT fee FROM kairos.fills WHERE order_id = $1`, [exec1.orderId]);
    const entryFee = Number(feeRows[0].fee);
    const tp = Number(pos.tp);
    const resolution = resolveBracket(
      { entry: Number(pos.entry), size: Number(pos.size), sl: Number(pos.sl), tp, entryFee },
      { open: tp, high: tp + 1, low: Number(pos.entry), close: tp },
      DEFAULT_SIM_PARAMS,
    );
    expect(resolution?.hitType).toBe('tp');

    await closePosition(pos.id, resolution!.realizedPnl, new Date('2026-03-07T01:00:00Z'));
    const closed = await query<{ status: string; realized_pnl: string }>(`SELECT status, realized_pnl FROM kairos.positions WHERE id = $1`, [pos.id]);
    expect(closed[0].status).toBe('closed');
    expect(Number(closed[0].realized_pnl)).toBeCloseTo(resolution!.realizedPnl, 6);
  });
});
