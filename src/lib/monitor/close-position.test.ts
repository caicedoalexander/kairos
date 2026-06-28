import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { persistDecision } from '../../db/repositories/decisions.ts';
import { executeOrderSim } from '../execution/execute-order.ts';
import { openPosition, getOpenPositions } from '../../db/repositories/positions.ts';
import { resolveBracket } from '../execution/bracket.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { closePositionOnBracket } from './close-position.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { RiskResult } from '../execution/types.ts';

const SYMBOL = 'CLOSEBTC/USDT';
const STRATEGY_ID = 'close-test-strategy';
const STRATEGY: Strategy = { id: STRATEGY_ID, enabled: true, symbols: [SYMBOL], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: {}, version: 1, skillName: null };
const RISK_ALLOW: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 1, notional: 100, limitsSnapshot: {} };

async function openOne() {
  // trigger_config con timeframes reales: getOpenPositions excluye estrategias sin trigger-TF.
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version) VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO UPDATE SET trigger_config = $3::jsonb`, [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } })]);
  const signal: Signal = { strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-11T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
  const signalId = await insertSignal(signal);
  const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  await executeOrderSim({ signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW, strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim' });
}

beforeAll(async () => { await migrate(); });
afterEach(async () => {
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});
afterAll(async () => { await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]); await pool.end(); });

describe('closePositionOnBracket', () => {
  test('cierra la posición, cierra las legs y audita; idempotente', async () => {
    await openOne();
    const pos = (await getOpenPositions('sim')).find((p) => p.symbol === SYMBOL)!;
    const tpBar = { open: pos.tp, high: pos.tp + 1, low: pos.entry, close: pos.tp };
    const resolution = resolveBracket(pos, tpBar, DEFAULT_SIM_PARAMS)!;
    expect(resolution.hitType).toBe('tp');

    const closed = await closePositionOnBracket(pos, resolution, new Date('2026-03-11T01:00:00Z'));
    expect(closed).toBe(true);

    const prow = await query<{ status: string; realized_pnl: string }>(`SELECT status, realized_pnl FROM kairos.positions WHERE id=$1`, [pos.id]);
    expect(prow[0].status).toBe('closed');
    expect(Number(prow[0].realized_pnl)).toBeCloseTo(resolution.realizedPnl, 6);
    const legs = await query<{ status: string }>(`SELECT status FROM kairos.orders WHERE decision_id=$1 AND purpose IN ('sl','tp')`, [pos.decisionId]);
    expect(legs.every((l) => l.status !== 'pending')).toBe(true);
    const audit = await query(`SELECT 1 FROM kairos.audit_log WHERE event_type='position_closed_sim' AND payload->>'positionId'=$1`, [pos.id]);
    expect(audit.length).toBe(1);

    expect(await closePositionOnBracket(pos, resolution, new Date('2026-03-11T02:00:00Z'))).toBe(false); // ya cerrada
  });

  test('rama SL: pnl negativo y sl leg filled, tp leg canceled', async () => {
    await openOne();
    const pos = (await getOpenPositions('sim')).find((p) => p.symbol === SYMBOL)!;
    // Vela que toca SL (low=90 <= sl=95); open=100 > sl → ref=sl=95 (sin gap-through)
    const slBar = { open: 100, high: 101, low: 90, close: 96 };
    const resolution = resolveBracket(pos, slBar, DEFAULT_SIM_PARAMS)!;
    expect(resolution.hitType).toBe('sl');

    const closed = await closePositionOnBracket(pos, resolution, new Date('2026-03-11T01:00:00Z'));
    expect(closed).toBe(true);

    const prow = await query<{ status: string; realized_pnl: string }>(
      `SELECT status, realized_pnl FROM kairos.positions WHERE id=$1`, [pos.id],
    );
    expect(prow[0].status).toBe('closed');
    expect(Number(prow[0].realized_pnl)).toBeCloseTo(resolution.realizedPnl, 6);
    expect(Number(prow[0].realized_pnl)).toBeLessThan(0);

    const legs = await query<{ purpose: string; status: string }>(
      `SELECT purpose, status FROM kairos.orders WHERE decision_id=$1 AND purpose IN ('sl','tp')`,
      [pos.decisionId],
    );
    const sl = legs.find((l) => l.purpose === 'sl')!;
    const tp = legs.find((l) => l.purpose === 'tp')!;
    expect(sl.status).toBe('filled');
    expect(tp.status).toBe('canceled');
  });

  test('decisionId null: cierra posición y audita sin tocar órdenes', async () => {
    // Posición sin decision_id (sin legs OCO); requiere la FK de estrategia.
    await query(
      `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
       VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`,
      [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify(STRATEGY.triggerConfig)],
    );
    const posId = await openPosition({
      symbol: SYMBOL, entry: 100, size: 1, sl: 95, tp: 110,
      strategyId: STRATEGY_ID, mode: 'sim', entryFee: 0,
      // sin decisionId → null
    });
    const pos = {
      id: posId, symbol: SYMBOL, strategyId: STRATEGY_ID, decisionId: null,
      entry: 100, size: 1, sl: 95, tp: 110, entryFee: 0,
      triggerTimeframe: '15m', mode: 'sim' as const, openedAt: new Date(),
    };

    const slBar = { open: 100, high: 101, low: 90, close: 96 };
    const resolution = resolveBracket(pos, slBar, DEFAULT_SIM_PARAMS)!;
    expect(resolution.hitType).toBe('sl');

    const closed = await closePositionOnBracket(pos, resolution, new Date('2026-03-11T01:00:00Z'));
    expect(closed).toBe(true);

    const prow = await query<{ status: string; realized_pnl: string }>(
      `SELECT status, realized_pnl FROM kairos.positions WHERE id=$1`, [posId],
    );
    expect(prow[0].status).toBe('closed');
    expect(Number(prow[0].realized_pnl)).toBeLessThan(0);

    const audit = await query(
      `SELECT 1 FROM kairos.audit_log WHERE event_type='position_closed_sim' AND payload->>'positionId'=$1`,
      [posId],
    );
    expect(audit.length).toBe(1);
  });
});
