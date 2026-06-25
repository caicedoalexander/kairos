import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { seedStrategies } from '../seed-strategies.ts';
import { getStrategy, getEnabledStrategies } from './strategies.ts';

beforeAll(async () => { await migrate(); await seedStrategies(); });
afterAll(async () => { await pool.end(); });

describe('strategies repo', () => {
  test('getStrategy parsea trigger_config de la semilla', async () => {
    const s = await getStrategy('pullback-alcista');
    expect(s?.triggerConfig.timeframes).toEqual({ bias: '4h', context: '1h', trigger: '15m' });
    expect(s?.symbols).toContain('BTC/USDT');
    expect(s?.enabled).toBe(true);
  });
  test('getEnabledStrategies incluye la semilla', async () => {
    const list = await getEnabledStrategies();
    expect(list.some((s) => s.id === 'pullback-alcista')).toBe(true);
  });
  test('getStrategy de un id inexistente → null', async () => {
    expect(await getStrategy('no-existe')).toBeNull();
  });
});
