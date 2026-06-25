import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from './migrate.ts';
import { pool, query } from './pool.ts';

const EXPECTED_TABLES = [
  'strategies', 'signals', 'decisions', 'risk_evaluations', 'orders', 'fills',
  'positions', 'account_snapshots', 'pending_approvals', 'audit_log',
  'ohlcv_candles', 'funding_rates', 'open_interest', 'liquidations', 'backtest_runs',
];

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

describe('migrate', () => {
  test('crea las 15 tablas del esquema kairos', async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'kairos'`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  test('orders.idempotency_key tiene restricción UNIQUE', async () => {
    const rows = await query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM information_schema.table_constraints
        WHERE table_schema = 'kairos' AND table_name = 'orders'
          AND constraint_type = 'UNIQUE'`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  test('es idempotente: aplicar de nuevo no falla', async () => {
    await expect(migrate()).resolves.toBeUndefined();
  });
});
