// src/lib/execution/execute-order-real.integration.test.ts
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { persistDecision } from '../../db/repositories/decisions.ts';
import { executeOrderReal, type RealOrderDeps } from './execute-order-real.ts';
import type { RiskResult, Verdict } from './types.ts';

const SYMBOL = 'REALBTC/USDT';
const STRATEGY_ID = 'real-strategy';
const VERDICT: Verdict = { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 };
const RISK: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 0.01, notional: 1, limitsSnapshot: {} };

// Lock que siempre adquiere (ejecuta fn directo); inyectable para no tocar Redis.
const passLock: NonNullable<RealOrderDeps['withLock']> = async (_s, _sym, _m, fn) => fn();

function baseDeps(over: Partial<RealOrderDeps>): RealOrderDeps {
  return {
    client: {
      market: () => ({ id: 'REALBTCUSDT', base: 'BTC', limits: { amount: { min: 0.0001 }, cost: { min: 0.1 } } }),
      amountToPrecision: (_s: string, a: number) => String(a),   // H2: el ejecutor llama amountToPrecision
      priceToPrecision: (_s: string, p: number) => String(p),
    } as never,
    placeEntry: async () => ({ belowMin: false, filledQty: 0.01, avgPrice: 100.04, fee: 0.00001, feeBase: 0.00001, exchangeOrderId: 'E1' }),
    placeOco: async () => ({ orderListId: 'L1', slOrderId: 'S1', tpOrderId: 'T1' }),
    emergencyClose: async () => ({ exitPrice: 94.9, exitFee: 0.4, exchangeOrderId: 'X1' }),
    withLock: passLock,
    hasOpenForSetup: async () => false,
    ...over,
  };
}

async function seed() {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
               VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1) ON CONFLICT (id) DO UPDATE SET trigger_config=$3::jsonb`,
    [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify({ timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } })]);
  const signalId = await insertSignal({ strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date('2026-03-11T00:00:00Z'),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } });
  const decision = await persistDecision(signalId, VERDICT);
  return { signalId, decision };
}
function params(signalId: string, decision: { id: string }) {
  return { signalId, symbol: SYMBOL, strategyId: STRATEGY_ID, decision: { id: decision.id, verdict: VERDICT }, riskResult: RISK, refPrice: 100, mode: 'testnet' as const };
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

describe('executeOrderReal', () => {
  test('camino feliz: filled, posición protected=true, legs con exchange id', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({}));
    expect(r.status).toBe('filled');
    const pos = await query<{ protected: boolean; size: string }>(`SELECT protected, size FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos[0].protected).toBe(true);
    expect(Number(pos[0].size)).toBeCloseTo(0.00999, 5); // 0.01 − feeBase 0.00001
    const legs = await query<{ purpose: string; exchange_order_id: string }>(
      `SELECT o.purpose, o.exchange_order_id FROM kairos.orders o
       JOIN kairos.decisions d ON d.id = o.decision_id
       JOIN kairos.signals s ON s.id = d.signal_id
       WHERE o.purpose IN ('sl','tp') AND s.symbol = $1`, [SYMBOL]);
    expect(legs.map((l) => l.exchange_order_id).sort()).toEqual(['S1', 'T1']);
  });

  test('fallo de OCO → emergency_closed, posición cerrada', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({ placeOco: async () => { throw new Error('oco down'); } }));
    expect(r.status).toBe('emergency_closed');
    const pos = await query<{ status: string }>(`SELECT status FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos[0].status).toBe('closed');
  });

  test('fill incierto (placeEntry lanza) → pending_execution, sin posición', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({ placeEntry: async () => { throw new Error('timeout'); } }));
    expect(r.status).toBe('pending_execution');
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos.length).toBe(0);
    const ord = await query<{ status: string }>(
      `SELECT o.status FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE o.purpose='entry' AND s.symbol=$1`,
      [SYMBOL],
    );
    expect(ord[0].status).toBe('pending_execution');
  });

  test('zero fill (IOC no cruzó) → zero_fill, sin posición', async () => {
    const { signalId, decision } = await seed();
    const r = await executeOrderReal(params(signalId, decision), baseDeps({ placeEntry: async () => ({ belowMin: false, filledQty: 0, avgPrice: 0, fee: 0, feeBase: 0, exchangeOrderId: '0' }) }));
    expect(r.status).toBe('zero_fill');
    expect((await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL])).length).toBe(0);
  });

  test('lock no adquirido → deduped, no toca el exchange', async () => {
    const { signalId, decision } = await seed();
    let entryCalls = 0;
    const r = await executeOrderReal(params(signalId, decision), baseDeps({
      withLock: async () => ({ lock: 'not_acquired' }) as never,
      placeEntry: async () => { entryCalls++; return { belowMin: false, filledQty: 0.01, avgPrice: 100, fee: 0, feeBase: 0, exchangeOrderId: 'E' }; },
    }));
    expect(r.status).toBe('deduped');
    expect(entryCalls).toBe(0);
  });

  test('re-check dentro del lock: setup ya abierto → deduped sin comprar', async () => {
    const { signalId, decision } = await seed();
    let entryCalls = 0;
    const r = await executeOrderReal(params(signalId, decision), baseDeps({
      hasOpenForSetup: async () => true,
      placeEntry: async () => { entryCalls++; return { belowMin: false, filledQty: 0.01, avgPrice: 100, fee: 0, feeBase: 0, exchangeOrderId: 'E' }; },
    }));
    expect(r.status).toBe('deduped');
    expect(entryCalls).toBe(0);
  });

  test('idempotencia: segundo job con el mismo signalId → duplicate', async () => {
    const { signalId, decision } = await seed();
    await executeOrderReal(params(signalId, decision), baseDeps({}));
    const r2 = await executeOrderReal(params(signalId, decision), baseDeps({ hasOpenForSetup: async () => false }));
    expect(r2.status).toBe('duplicate');
  });

  // H4: carrera de setup (lock expirado). Hay una posición abierta del MISMO setup, pero el re-check
  // se saltea (hasOpenForSetup=false simula lock expirado/stale) → openPosition choca con el índice
  // único parcial idx_positions_open_setup (23505) → compensateSetupRace.
  test('carrera de setup (23505 en openPosition) → emergency_closed; entry queda filled', async () => {
    const { signalId, decision } = await seed();
    // Posición conflictiva preexistente del mismo (strategy, symbol, mode):
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, entry_fee, protected)
                 VALUES ('conflict01', $1, 'long', 100, 0.01, 95, 110, 'open', $2, 'testnet', 0, true)`, [SYMBOL, STRATEGY_ID]);
    let emergencyCalled = 0;
    const r = await executeOrderReal(params(signalId, decision), baseDeps({
      hasOpenForSetup: async () => false,   // simula lock expirado: el re-check no ve la posición
      emergencyClose: async () => { emergencyCalled++; return { exitPrice: 94.9, exitFee: 0.4, exchangeOrderId: 'X1' }; },
    }));
    expect(r.status).toBe('emergency_closed');
    expect(emergencyCalled).toBe(1);   // la compra real se aplanó
    const entry = await query<{ status: string }>(`SELECT status FROM kairos.orders WHERE idempotency_key=$1`, [signalId]);
    expect(entry[0].status).toBe('filled');
    await query(`DELETE FROM kairos.positions WHERE id='conflict01'`);
  });

  test('dust: qty insuficiente → emergency_closed, orden filled, 2 fills, sin posición', async () => {
    const { signalId, decision } = await seed();
    let emergencyCalled = 0;
    // Market con mínimo de 0.01 BTC; sellableQty (0.01 − feeBase 0.00001 = 0.00999) < 0.01 → dispara dust.
    const dustClient = {
      market: () => ({ id: 'REALBTCUSDT', base: 'BTC', limits: { amount: { min: 0.01 }, cost: { min: 0.1 } } }),
      amountToPrecision: (_s: string, a: number) => String(a),
      priceToPrecision: (_s: string, p: number) => String(p),
    } as never;
    const r = await executeOrderReal(params(signalId, decision), baseDeps({
      client: dustClient,
      emergencyClose: async () => { emergencyCalled++; return { exitPrice: 94.9, exitFee: 0.4, exchangeOrderId: 'X2' }; },
    }));
    expect(r.status).toBe('emergency_closed');
    expect(emergencyCalled).toBe(1);
    // La orden queda 'filled', no 'pending_execution'.
    const ord = await query<{ status: string }>(
      `SELECT o.status FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE o.purpose='entry' AND s.symbol=$1`,
      [SYMBOL],
    );
    expect(ord[0].status).toBe('filled');
    // Hay exactamente 2 fills (entrada + salida de emergencia).
    const fills = await query<{ id: string }>(
      `SELECT f.id FROM kairos.fills f JOIN kairos.orders o ON o.id=f.order_id JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1`,
      [SYMBOL],
    );
    expect(fills.length).toBe(2);
    // No hay fila de posición abierta.
    const pos = await query(`SELECT 1 FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
    expect(pos.length).toBe(0);
  });

  test('carrera de setup con emergencyClose que TAMBIÉN falla → re-lanza; entry pending_execution', async () => {
    const { signalId, decision } = await seed();
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, entry_fee, protected)
                 VALUES ('conflict02', $1, 'long', 100, 0.01, 95, 110, 'open', $2, 'testnet', 0, true)`, [SYMBOL, STRATEGY_ID]);
    await expect(executeOrderReal(params(signalId, decision), baseDeps({
      hasOpenForSetup: async () => false,
      emergencyClose: async () => { throw new Error('emergency down'); },
    }))).rejects.toThrow('emergency_close_failed');
    const entry = await query<{ status: string }>(`SELECT status FROM kairos.orders WHERE idempotency_key=$1`, [signalId]);
    expect(entry[0].status).toBe('pending_execution');   // marcador durable queryable (sin fila de posición)
    await query(`DELETE FROM kairos.positions WHERE id='conflict02'`);
  });
});
