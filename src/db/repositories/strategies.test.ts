import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { seedStrategies } from '../seed-strategies.ts';
import { getStrategy, getEnabledStrategies } from './strategies.ts';

beforeAll(async () => {
  await migrate();
  await seedStrategies();
  // Deshabilita cualquier estrategia de test que haya acumulado trigger_config vacío en la DB
  // compartida (artefactos de ejecuciones de test anteriores a SP13 que usaban ULIDs y
  // enabled=true). getEnabledStrategies es fail-loud: lanzaría al parsear configs inválidos.
  // Esta limpieza es idempotente y no afecta pullback-alcista (que tiene config completo).
  await query(`UPDATE kairos.strategies SET enabled=false WHERE id != 'pullback-alcista' AND trigger_config = '{}'::jsonb AND enabled=true`);
});
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
