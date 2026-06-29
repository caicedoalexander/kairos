import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
afterEach(async () => {
  await query(`DELETE FROM kairos.audit_log WHERE payload->>'symbol'=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.risk_evaluations WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => {
  await query(`DELETE FROM kairos.audit_log WHERE payload->>'symbol'=$1`, [SYMBOL]);
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

  test('dedup: segunda señal del mismo setup con posición abierta → skipped, sin segunda posición', async () => {
    const firstId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    const first = await evaluateCandidate(firstId, { notify, riskState: ALLOW_STATE });
    expect(first.kind).toBe('executed');

    const secondId = await insertSignal(enterSignal());   // mismo setup, distinta señal
    const second = await evaluateCandidate(secondId, { notify, riskState: ALLOW_STATE });
    expect(second.kind).toBe('skipped');
    if (second.kind === 'skipped') expect(second.reason).toContain('dedup');

    const cnt = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM kairos.positions WHERE symbol=$1 AND status='open'`, [SYMBOL]);
    expect(Number(cnt[0].n)).toBe(1);
  });

  test('dedup pre-check: segunda señal del mismo setup emite audit_log entry_deduped', async () => {
    const firstId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'stub' }));
    const first = await evaluateCandidate(firstId, { notify, riskState: ALLOW_STATE });
    expect(first.kind).toBe('executed');

    const secondId = await insertSignal(enterSignal());
    const second = await evaluateCandidate(secondId, { notify, riskState: ALLOW_STATE });
    expect(second.kind).toBe('skipped');

    const rows = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM kairos.audit_log WHERE event_type='entry_deduped' AND payload->>'symbol'=$1`,
      [SYMBOL],
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
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

  test('notify best-effort: un fallo de notify NO tumba la evaluación tras ejecutar', async () => {
    const signalId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => { throw new Error('Evolution caído'); });
    // La notificación es capa separada best-effort: un fallo nunca debe propagarse tras mover dinero.
    const outcome = await evaluateCandidate(signalId, { notify, riskState: ALLOW_STATE });
    expect(outcome.kind).toBe('executed');
    expect(notify).toHaveBeenCalledOnce();
    if (outcome.kind !== 'executed') throw new Error('esperaba executed');
    expect(outcome.status).toBe('filled');
    expect(outcome.positionId).not.toBeNull();
    // la posición se creó pese al fallo de notify
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE id=$1`, [outcome.positionId]);
    expect(pos.length).toBe(1);
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

  test('kill-switch ON: retorna skipped sin ejecutar (H1)', async () => {
    const notify = vi.fn(async () => ({ messageId: null }));
    const r = await evaluateCandidate('cualquier-signal', { isPaused: async () => true, notify });
    expect(r.kind).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/kill-switch/i);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('evaluateCandidate — despacho por modo (SP12)', () => {
  const OLD_MODE = process.env.KAIROS_MODE;
  afterEach(() => { process.env.KAIROS_MODE = OLD_MODE; });

  test('en testnet rutea a executeReal (NO al sim) y mapea el outcome', async () => {
    process.env.KAIROS_MODE = 'testnet';
    const signalId = await insertSignal(enterSignal());
    let realCalls = 0;
    const notify = vi.fn(async () => ({ messageId: 'm' }));
    const outcome = await evaluateCandidate(signalId, {
      notify, riskState: ALLOW_STATE,
      executeReal: async () => { realCalls++; return { status: 'filled', idempotencyKey: signalId, orderId: 'o', positionId: 'p', fillPrice: 100, qty: 0.01, fee: 0 }; },
    });
    expect(realCalls).toBe(1);
    expect(outcome.kind).toBe('executed');
    if (outcome.kind === 'executed') expect(outcome.status).toBe('filled');
    // NO se creó posición vía sim (el executeReal fake no escribe DB)
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos.length).toBe(0);
  });

  test('en testnet con zero_fill → executed/zero_fill y notifica', async () => {
    process.env.KAIROS_MODE = 'testnet';
    const signalId = await insertSignal(enterSignal());
    const notify = vi.fn(async () => ({ messageId: 'm' }));
    const outcome = await evaluateCandidate(signalId, {
      notify, riskState: ALLOW_STATE,
      executeReal: async () => ({ status: 'zero_fill', idempotencyKey: signalId, orderId: '', positionId: null, fillPrice: null, qty: null, fee: null }),
    });
    expect(outcome).toEqual({ kind: 'executed', positionId: null, status: 'zero_fill' });
    expect(notify).toHaveBeenCalledOnce();
  });

  test('en sim NO se llama executeReal (rama intacta)', async () => {
    process.env.KAIROS_MODE = 'sim';
    const signalId = await insertSignal(enterSignal());
    let realCalls = 0;
    const outcome = await evaluateCandidate(signalId, {
      notify: vi.fn(async () => ({ messageId: 'm' })), riskState: ALLOW_STATE,
      executeReal: async () => { realCalls++; return { status: 'filled', idempotencyKey: signalId, orderId: '', positionId: null, fillPrice: null, qty: null, fee: null }; },
    });
    expect(realCalls).toBe(0);                  // sim usa executeOrderSim, no executeReal
    expect(outcome.kind).toBe('executed');
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos.length).toBe(1);                 // sim sí escribió la posición
  });
});
