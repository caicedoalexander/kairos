import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from './migrate.ts';
import { pool, query, withTransaction } from './pool.ts';

const ACTOR = 'tx-test-actor';

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.audit_log WHERE actor = $1', [ACTOR]);
  await pool.end();
});

describe('withTransaction', () => {
  test('commitea las escrituras cuando el callback resuelve', async () => {
    await withTransaction(async (exec) => {
      await exec(
        `INSERT INTO kairos.audit_log (id, event_type, actor, payload) VALUES ($1,$2,$3,$4)`,
        ['tx-ok-1', 'commit_marker', ACTOR, '{}'],
      );
    });
    const rows = await query('SELECT id FROM kairos.audit_log WHERE id = $1', ['tx-ok-1']);
    expect(rows).toHaveLength(1);
  });

  test('hace rollback cuando el callback lanza', async () => {
    await expect(
      withTransaction(async (exec) => {
        await exec(
          `INSERT INTO kairos.audit_log (id, event_type, actor, payload) VALUES ($1,$2,$3,$4)`,
          ['tx-rollback-1', 'rollback_marker', ACTOR, '{}'],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await query('SELECT id FROM kairos.audit_log WHERE id = $1', ['tx-rollback-1']);
    expect(rows).toHaveLength(0);
  });
});
