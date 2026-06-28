import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../../db/migrate.ts';
import { pool, query } from '../../db/pool.ts';
import { insertSignal } from '../../db/repositories/signals.ts';
import { persistDecision } from '../../db/repositories/decisions.ts';
import { executeOrderSim } from '../execution/execute-order.ts';
import { getOpenPositions } from '../../db/repositories/positions.ts';
import { upsertCandles } from '../../db/repositories/ohlcv-candles.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { runMonitorTick } from './monitor-tick.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { RiskResult } from '../execution/types.ts';

const SYMBOL = 'MONITORINT/USDT';
const STRATEGY_ID = 'monitor-integration-strategy';
const STRATEGY: Strategy = {
  id: STRATEGY_ID, enabled: true, symbols: [SYMBOL],
  triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } },
  riskParams: {}, version: 1, skillName: null,
};
const RISK_ALLOW: RiskResult = { result: 'allow', reason: 'ok', adjustedSize: 1, notional: 100, limitsSnapshot: {} };

async function seedPosition() {
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, false, '15m', $2::text[], $3::jsonb, '{}'::jsonb, 1)
     ON CONFLICT (id) DO UPDATE SET trigger_config = $3::jsonb`,
    [STRATEGY_ID, `{${SYMBOL}}`, JSON.stringify(STRATEGY.triggerConfig)],
  );
  const signal: Signal = {
    strategyId: STRATEGY_ID, symbol: SYMBOL, firedAt: new Date(),
    snapshot: { byTimeframe: {}, mtfAlignment: 'aligned',
      levels: { support: null, resistance: null },
      derivatives: { fundingZ: null, oiChangePct: null } },
  };
  const signalId = await insertSignal(signal);
  const decision = await persistDecision(signalId, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1 });
  return executeOrderSim({
    signalId, symbol: SYMBOL, decision, riskResult: RISK_ALLOW,
    strategy: STRATEGY, referencePrice: 100, simParams: DEFAULT_SIM_PARAMS, mode: 'sim',
  });
}

beforeAll(async () => { await migrate(); });

afterEach(async () => {
  await query(`DELETE FROM kairos.ohlcv_candles WHERE symbol = $1`, [SYMBOL]);
  await query(`DELETE FROM kairos.fills WHERE order_id IN (SELECT o.id FROM kairos.orders o JOIN kairos.decisions d ON d.id=o.decision_id JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.positions WHERE symbol=$1`, [SYMBOL]);
  await query(`DELETE FROM kairos.orders WHERE decision_id IN (SELECT d.id FROM kairos.decisions d JOIN kairos.signals s ON s.id=d.signal_id WHERE s.symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.decisions WHERE signal_id IN (SELECT id FROM kairos.signals WHERE symbol=$1)`, [SYMBOL]);
  await query(`DELETE FROM kairos.signals WHERE symbol=$1`, [SYMBOL]);
});

afterAll(async () => {
  await query(`DELETE FROM kairos.strategies WHERE id=$1`, [STRATEGY_ID]);
  await pool.end();
});

describe('runMonitorTick integración', () => {
  test('anti-look-ahead: vela de entrada excluida; vela posterior toca SL → cierra la posición', async () => {
    await seedPosition();

    // Leer la posición para obtener su opened_at real
    const positions = await getOpenPositions('sim');
    const pos = positions.find((p) => p.symbol === SYMBOL)!;
    expect(pos).toBeDefined();

    const openedAt = pos.openedAt;

    // Vela de ENTRADA: open_time ANTES de openedAt, con low=90<=sl=95 → debe ser EXCLUIDA
    const entryCandle = {
      symbol: SYMBOL, timeframe: '15m',
      openTime: new Date(openedAt.getTime() - 60_000),  // 1 minuto antes
      o: 100, h: 101, l: 90, c: 96, v: 1,
    };
    // Vela POSTERIOR: open_time DESPUÉS de openedAt, con low=90<=sl=95 → debe ser INCLUIDA
    const hitCandle = {
      symbol: SYMBOL, timeframe: '15m',
      openTime: new Date(openedAt.getTime() + 60_000),  // 1 minuto después
      o: 100, h: 101, l: 90, c: 96, v: 1,
    };
    await upsertCandles([entryCandle, hitCandle]);

    // asOf engloba la vela posterior (2 minutos después de openedAt)
    const asOf = new Date(openedAt.getTime() + 120_000);

    const result = await runMonitorTick(asOf, {
      // Best-effort: inyectamos notify no-op para no llamar a WhatsApp real
      notify: async () => ({ messageId: null }),
    });

    expect(result.checked).toBe(1);
    expect(result.closed).toBe(1);

    // La posición debe estar cerrada con semántica SL (pnl negativo)
    const prow = await query<{ status: string; realized_pnl: string }>(
      `SELECT status, realized_pnl FROM kairos.positions WHERE id=$1`, [pos.id],
    );
    expect(prow[0].status).toBe('closed');
    expect(Number(prow[0].realized_pnl)).toBeLessThan(0);

    // Legs OCO: sl=filled, tp=canceled
    const legs = await query<{ purpose: string; status: string }>(
      `SELECT purpose, status FROM kairos.orders WHERE decision_id=$1 AND purpose IN ('sl','tp')`,
      [pos.decisionId],
    );
    const sl = legs.find((l) => l.purpose === 'sl')!;
    const tp = legs.find((l) => l.purpose === 'tp')!;
    expect(sl.status).toBe('filled');
    expect(tp.status).toBe('canceled');

    // Registro de auditoría de cierre
    const audit = await query(
      `SELECT 1 FROM kairos.audit_log WHERE event_type='position_closed_sim' AND payload->>'positionId'=$1`,
      [pos.id],
    );
    expect(audit.length).toBe(1);
  });
});
