import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { query } from '../pool.ts';
import { pool } from '../pool.ts';
import { ulid } from 'ulidx';
import { getFillsForOrder } from './fills.ts';
import { findUnresolvedEntries, hasUnresolvedEntryForSetup, getBracketLegs } from './orders.ts';
import { findUnprotectedPositions, getProtectedOpenPositions } from './positions.ts';

// ID fijo para la estrategia de prueba: evita contaminar kairos.strategies con ULIDs acumulados.
const TEST_STRATEGY_ID = 'sp13-reads-test-strategy';

// Helpers mínimos para sembrar el grafo strategy→signal→decision→order/position.
async function seedStrategy(): Promise<string> {
  // FIX H-1 (plan-review): kairos.strategies NO tiene columna `name`; `timeframe` es NOT NULL.
  // enabled=false: no contamina getEnabledStrategies (que parseará trigger_config).
  // ON CONFLICT DO UPDATE SET enabled=false: garantiza que una fila pre-existente con enabled=true
  // (de una ejecución anterior a este fix) quede deshabilitada, evitando que getEnabledStrategies
  // intente parsear trigger_config vacío y falle (fail-loud, sin try/catch en producción).
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, trigger_config, risk_params)
               VALUES ($1, false, '15m', '{}'::jsonb, '{}'::jsonb)
               ON CONFLICT (id) DO UPDATE SET enabled = false`, [TEST_STRATEGY_ID]);
  return TEST_STRATEGY_ID;
}
async function seedSignal(strategyId: string, symbol: string): Promise<string> {
  const id = ulid();
  await query(`INSERT INTO kairos.signals (id, strategy_id, symbol, indicator_snapshot) VALUES ($1, $2, $3, '{}'::jsonb)`, [id, strategyId, symbol]);
  return id;
}
async function seedDecision(signalId: string): Promise<string> {
  const id = ulid();
  await query(`INSERT INTO kairos.decisions (id, signal_id, verdict) VALUES ($1, $2, '{}'::jsonb)`, [id, signalId]);
  return id;
}

describe('SP13 reads (integración)', () => {
  // Siembra la estrategia de prueba en beforeAll para garantizar que la fila exista con
  // enabled=false ANTES de que cualquier test corra — incluyendo tests de otros archivos
  // que corren en paralelo (strategies.test.ts) y llaman a getEnabledStrategies(), que
  // lanzaría si encuentra una fila con trigger_config vacío y enabled=true (fail-loud).
  beforeAll(async () => { await seedStrategy(); });

  beforeEach(async () => {
    // Aísla: limpia SOLO los datos de esta estrategia de prueba (scoped por strategy_id)
    // para no interferir con otros test files que corren en paralelo y usan mode='testnet'.
    await query(`DELETE FROM kairos.fills WHERE order_id IN (
      SELECT o.id FROM kairos.orders o
      JOIN kairos.decisions d ON d.id = o.decision_id
      JOIN kairos.signals s ON s.id = d.signal_id
      WHERE s.strategy_id = $1 AND o.mode = 'testnet'
    )`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.orders WHERE mode = 'testnet' AND decision_id IN (
      SELECT d.id FROM kairos.decisions d
      JOIN kairos.signals s ON s.id = d.signal_id
      WHERE s.strategy_id = $1
    )`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.positions WHERE strategy_id = $1 AND mode = 'testnet'`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE strategy_id = $1)`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.signals WHERE strategy_id = $1`, [TEST_STRATEGY_ID]);
  });

  afterAll(async () => {
    // Limpieza final: elimina el grafo completo (el last test puede haber dejado datos).
    await query(`DELETE FROM kairos.fills WHERE order_id IN (
      SELECT o.id FROM kairos.orders o
      JOIN kairos.decisions d ON d.id = o.decision_id
      JOIN kairos.signals s ON s.id = d.signal_id
      WHERE s.strategy_id = $1 AND o.mode = 'testnet'
    )`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.orders WHERE mode = 'testnet' AND decision_id IN (
      SELECT d.id FROM kairos.decisions d
      JOIN kairos.signals s ON s.id = d.signal_id
      WHERE s.strategy_id = $1
    )`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.positions WHERE strategy_id = $1 AND mode = 'testnet'`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE strategy_id = $1)`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.signals WHERE strategy_id = $1`, [TEST_STRATEGY_ID]);
    await query(`DELETE FROM kairos.strategies WHERE id = $1`, [TEST_STRATEGY_ID]);
    await pool.end();
  });

  it('getFillsForOrder devuelve los fills de la orden', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    const oid = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'filled', 'testnet')`, [oid, sig, d]);
    await query(`INSERT INTO kairos.fills (id, order_id, price, qty, fee) VALUES ($1, $2, 100, 0.5, 0.05)`, [ulid(), oid]);
    const fills = await getFillsForOrder(oid);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ price: 100, qty: 0.5, fee: 0.05 });
  });

  it('findUnresolvedEntries: incluye vieja-sin-posición; excluye fresca (H1) y vieja-con-posición (idempotencia)', async () => {
    const s = await seedStrategy();
    // (a) vieja sin posición → DEBE aparecer.
    const sigA = await seedSignal(s, 'BTC/USDT'); const dA = await seedDecision(sigA);
    const oldId = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending_execution', 'testnet', now() - interval '10 minutes')`, [oldId, sigA, dA]);
    // (b) fresca (dentro de la ventana del lock) → NO debe aparecer (FIX H1).
    const sigB = await seedSignal(s, 'ETH/USDT'); const dB = await seedDecision(sigB);
    const freshOrderId = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending', 'testnet', now())`, [freshOrderId, sigB, dB]);
    // (c) vieja PERO con posición ya abierta para su decisión → NO debe aparecer (idempotencia A.1).
    const sigC = await seedSignal(s, 'SOL/USDT'); const dC = await seedDecision(sigC);
    const withPosId = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending_execution', 'testnet', now() - interval '10 minutes')`, [withPosId, sigC, dC]);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, decision_id, protected)
                 VALUES ($1, 'SOL/USDT', 'long', 1, 1, 0.9, 1.1, 'open', $2, 'testnet', $3, false)`, [ulid(), s, dC]);

    const ids = (await findUnresolvedEntries('testnet')).map((e) => e.id);
    expect(ids).toContain(oldId);             // (a) sí
    expect(ids).not.toContain(freshOrderId);  // (b) no — filtro de frescura (compara IDs de ORDEN, no de señal)
    expect(ids).not.toContain(withPosId);     // (c) no — ya tiene posición
  });

  it('hasUnresolvedEntryForSetup es true para una pending FRESCA (sin filtro de frescura — gate)', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode, created_at)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'pending_execution', 'testnet', now())`, [ulid(), sig, d]);
    expect(await hasUnresolvedEntryForSetup(s, 'BTC/USDT', 'testnet')).toBe(true);
    expect(await hasUnresolvedEntryForSetup(s, 'SOL/USDT', 'testnet')).toBe(false);
  });

  it('getBracketLegs devuelve sl/tp con exchange_order_id', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    const parent = ulid();
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, status, mode)
                 VALUES ($1, $2, $3, 'buy', 1, 'limit', 'entry', 'filled', 'testnet')`, [parent, sig, d]);
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, parent_id, status, mode, exchange_order_id)
                 VALUES ($1, $2, $3, 'sell', 1, 'stop_loss_limit', 'sl', $4, 'pending', 'testnet', 'X-SL')`, [ulid(), `${sig}:sl`, d, parent]);
    await query(`INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, purpose, parent_id, status, mode, exchange_order_id)
                 VALUES ($1, $2, $3, 'sell', 1, 'take_profit_limit', 'tp', $4, 'pending', 'testnet', 'X-TP')`, [ulid(), `${sig}:tp`, d, parent]);
    const legs = await getBracketLegs(d);
    expect(legs.map((l) => l.purpose).sort()).toEqual(['sl', 'tp']);
    expect(legs.find((l) => l.purpose === 'sl')?.exchangeOrderId).toBe('X-SL');
  });

  it('findUnprotectedPositions / getProtectedOpenPositions filtran por protected', async () => {
    const s = await seedStrategy(); const sig = await seedSignal(s, 'BTC/USDT'); const d = await seedDecision(sig);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, decision_id, protected)
                 VALUES ($1, 'BTC/USDT', 'long', 100, 0.5, 95, 110, 'open', $2, 'testnet', $3, false)`, [ulid(), s, d]);
    const sig2 = await seedSignal(s, 'ETH/USDT'); const d2 = await seedDecision(sig2);
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, decision_id, protected)
                 VALUES ($1, 'ETH/USDT', 'long', 50, 1, 47, 56, 'open', $2, 'testnet', $3, true)`, [ulid(), s, d2]);
    // Filtra por strategyId para aislar de otras pruebas concurrentes que también crean posiciones en testnet.
    const mine = (p: { strategyId: string }) => p.strategyId === s;
    expect((await findUnprotectedPositions('testnet')).filter(mine).map((p) => p.symbol)).toEqual(['BTC/USDT']);
    expect((await getProtectedOpenPositions('testnet')).filter(mine).map((p) => p.symbol)).toEqual(['ETH/USDT']);
  });
});
