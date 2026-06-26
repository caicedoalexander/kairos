import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from './migrate.ts';
import { pool } from './pool.ts';
import { seedStrategies } from './seed-strategies.ts';
import { getStrategy } from './repositories/strategies.ts';
import { parseRiskParams } from '../lib/execution/types.ts';

beforeAll(async () => { await migrate(); });
afterAll(async () => { await pool.end(); });

describe('seedStrategies', () => {
  test('pullback-alcista tiene risk_params completo (parseable) y version 2', async () => {
    await seedStrategies();
    const strategy = await getStrategy('pullback-alcista');
    expect(strategy).not.toBeNull();
    const rp = parseRiskParams(strategy!.riskParams);   // lanza si falta algún campo
    expect(rp.tp_r_multiple).toBe(2);
    expect(rp.max_open_positions).toBe(3);
    expect(strategy!.version).toBe(2);
  });
});
