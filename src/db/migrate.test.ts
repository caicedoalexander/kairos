import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from './migrate.ts';
import { pool, query } from './pool.ts';

const EXPECTED_TABLES = [
  'strategies', 'signals', 'decisions', 'risk_evaluations', 'orders', 'fills',
  'positions', 'account_snapshots', 'pending_approvals', 'audit_log',
  'ohlcv_candles', 'funding_rates', 'open_interest', 'liquidations', 'backtest_runs',
  'shadow_verdicts',
];

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

describe('migrate', () => {
  test('crea las 16 tablas del esquema kairos', async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'kairos'`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  test('orders.idempotency_key tiene restricción UNIQUE', async () => {
    const rows = await query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'kairos'
          AND tc.table_name = 'orders'
          AND tc.constraint_type = 'UNIQUE'`,
    );
    expect(rows.map((r) => r.column_name)).toContain('idempotency_key');
  });

  test('es idempotente: aplicar de nuevo no falla', async () => {
    await expect(migrate()).resolves.toBeUndefined();
  });
});
