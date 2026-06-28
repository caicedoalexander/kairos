import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { pool, query } from '../db/pool.ts';
import { insertSignal } from '../db/repositories/signals.ts';
import * as strategiesRepo from '../db/repositories/strategies.ts';
import { evaluateCandidate } from './evaluate-candidate.ts';
import type { Signal, Features } from '../lib/scanner/types.ts';
import type { GatheredState } from '../lib/execution/check-risk.ts';

const SYMBOL = 'EVALBTC/USDT';
const STRATEGY_ID = 'eval-test-strategy';
const RISK_PARAMS = { risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2, max_notional_pct: 50, max_total_exposure_pct: 100, max_open_positions: 3, max_symbol_exposure_pct: 100, max_daily_loss_pct: 3, max_drawdown_pct: 15, max_consecutive_losses: 4 };
const ALLOW_STATE: GatheredState = { equity: 100000, drawdownPct: 0, dailyPnl: 0, openNotionalTotal: 0, openNotionalSymbol: 0, openPositionsCount: 0, consecutiveLosses: 0 };

function features(close: number, atrPct: number): Features {
  return { close, emaStack: null, macdCross: null, adx: null, rsi: null, rsiPrev: null, rsiState: null, stochRsi: null, atrPct, bbPosition: null, aboveVwap: null, obv: null, mfi: null, nearestSupport: null, nearestResistance: null, distToSupportPct: null };
}
function enterSignal(): Signal {
  return { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-07T00:00:00Z'),
    snapshot: { byTimeframe: { '15m': features(100, 2) }, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
}
// atrPct=0 → buildDeterministicVerdict devuelve action:'skip' (condición atrPct<=0 en verdict.ts)
function skipSignal(): Signal {
  return { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-07T02:00:00Z'),
    snapshot: { byTimeframe: { '15m': features(100, 0) }, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
}

beforeAll(async () => {
  await migrate();
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, true, '15m', $2::text[], $3::jsonb, $4::jsonb, 2) ON CONFLICT (id) DO UPDATE SET enabled = true, risk_params = $4::jsonb`,
    [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }), JSON.stringify(RISK_PARAMS)],
  );
});
afterAll(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]);
  await pool.end();
});

describe('evaluateCandidate', () => {
  test('señal de entrada con riesgo allow → ejecuta y notifica', async () => {
    const signalId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    const outcome = await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    expect(outcome.kind).toBe('executed');
    if (outcome.kind === 'executed') {
      expect(outcome.status).toBe('filled');
      expect(outcome.positionId).not.toBeNull();
    }
    expect(notify).toHaveBeenCalledOnce();
  });

  test('idempotencia: reevaluar la misma señal → executed/duplicate, sin notificar de nuevo', async () => {
    const signalId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    const second = await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    expect(second.kind).toBe('executed');
    if (second.kind === 'executed') expect(second.status).toBe('duplicate');
    expect(notify).toHaveBeenCalledOnce(); // no re-notifica en duplicate
  });

  test('riesgo deny → no ejecuta, notifica el rechazo', async () => {
    const signalId = await insertSignal(enterSignal());
    const denyState: GatheredState = { ...ALLOW_STATE, dailyPnl: -99999, drawdownPct: 99 };
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    const outcome = await evaluateCandidate(signalId, { notify, riskState: denyState });
    expect(outcome.kind).toBe('denied');
    const orders = await query(`SELECT 1 FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id WHERE d.signal_id=$1`, [signalId]);
    expect(orders.length).toBe(0);
    expect(notify).toHaveBeenCalledOnce();
  });

  test('signalId inexistente → not_found, no lanza', async () => {
    const outcome = await evaluateCandidate('00000000000000000000000000', { notify: vi.fn(async () => ({ messageId: null })) });
    expect(outcome.kind).toBe('not_found');
  });

  test('veredicto skip (atrPct=0) → skipped, sin orden ni notificación', async () => {
    const signalId = await insertSignal(skipSignal());
    const notify = vi.fn(async () => ({ messageId: null }));
    const outcome = await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind === 'skipped') expect(outcome.reason).toBeTruthy();
    expect(notify).not.toHaveBeenCalled();
    const decisions = await query<{ id: string }>(
      `SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.id=$1`,
      [signalId],
    );
    expect(decisions.length).toBe(0);
  });

  test('señal válida con estrategia no registrada → not_found (path !strategy)', async () => {
    // La FK de signals.strategy_id impide insertar una señal con strategyId inexistente en la DB.
    // Se simula el retorno nulo de getStrategy para ejercer la rama if (!strategy).
    const signalId = await insertSignal(enterSignal());
    const spy = vi.spyOn(strategiesRepo, 'getStrategy').mockResolvedValueOnce(null);
    const notify = vi.fn(async () => ({ messageId: null }));
    const outcome = await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    spy.mockRestore();
    expect(outcome.kind).toBe('not_found');
    expect(notify).not.toHaveBeenCalled();
  });
});
