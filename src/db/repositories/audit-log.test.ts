import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { appendAuditLog } from './audit-log.ts';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

describe('appendAuditLog', () => {
  test('inserta una entrada y la devuelve por id', async () => {
    const id = await appendAuditLog({
      eventType: 'test.event',
      actor: 'vitest',
      payload: { hello: 'world' },
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // formato ULID

    const rows = await query<{ event_type: string; actor: string; payload: { hello: string } }>(
      `SELECT event_type, actor, payload FROM kairos.audit_log WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.event_type).toBe('test.event');
    expect(rows[0]?.actor).toBe('vitest');
    expect(rows[0]?.payload.hello).toBe('world');
  });

  test('payload por defecto es objeto vacío', async () => {
    const id = await appendAuditLog({ eventType: 'test.empty', actor: 'vitest' });
    const rows = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM kairos.audit_log WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.payload).toEqual({});
  });
});
