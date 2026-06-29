import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { getPaused, setPaused } from './bot-state.ts';

beforeAll(async () => { await migrate(); });
afterEach(async () => { await setPaused(false); });
afterAll(async () => { await pool.end(); });

describe('bot_state', () => {
  test('default no pausado; setPaused(true) → getPaused()===true; idempotente', async () => {
    expect(await getPaused()).toBe(false);
    await setPaused(true);
    expect(await getPaused()).toBe(true);
    await setPaused(true); // idempotente
    expect(await getPaused()).toBe(true);
    await setPaused(false);
    expect(await getPaused()).toBe(false);
  });
});
