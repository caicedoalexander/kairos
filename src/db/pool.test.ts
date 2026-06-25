import { describe, test, expect, afterAll } from 'vitest';
import { pool, query } from './pool.ts';

afterAll(async () => {
  await pool.end();
});

describe('pool', () => {
  test('query ejecuta SQL y devuelve filas tipadas', async () => {
    const rows = await query<{ one: number }>('SELECT 1 AS one');
    expect(rows[0]?.one).toBe(1);
  });
});
