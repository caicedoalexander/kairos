import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query, pool } from '../pool.ts';
import { ulid } from 'ulidx';
import { setPositionSl, getOpenPositionById } from './positions.ts';

const STRAT = 'trailing-reads-strategy';

async function seed(): Promise<void> {
  await query(`INSERT INTO kairos.strategies (id, enabled, timeframe, trigger_config, risk_params)
               VALUES ($1, false, '15m', '{}'::jsonb, '{}'::jsonb) ON CONFLICT (id) DO UPDATE SET enabled = false`, [STRAT]);
}

describe('trailing reads (integración)', () => {
  beforeEach(async () => { await seed(); await query(`DELETE FROM kairos.positions WHERE strategy_id = $1`, [STRAT]); });
  afterAll(async () => {
    await query(`DELETE FROM kairos.positions WHERE strategy_id = $1`, [STRAT]);
    await query(`DELETE FROM kairos.strategies WHERE id = $1`, [STRAT]);
    await pool.end();
  });

  it('getOpenPositionById devuelve la posición con protected; setPositionSl actualiza el sl', async () => {
    const id = ulid();
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, protected)
                 VALUES ($1, 'BTC/USDT', 'long', 100, 0.5, 95, 110, 'open', $2, 'testnet', true)`, [id, STRAT]);
    const pos = await getOpenPositionById(id);
    expect(pos?.protected).toBe(true);
    expect(pos?.sl).toBe(95);

    await setPositionSl(id, 105);
    expect((await getOpenPositionById(id))?.sl).toBe(105);
  });

  it('getOpenPositionById → null si no está open', async () => {
    const id = ulid();
    await query(`INSERT INTO kairos.positions (id, symbol, side, entry, size, sl, tp, status, strategy_id, mode, protected)
                 VALUES ($1, 'BTC/USDT', 'long', 100, 0.5, 95, 110, 'closed', $2, 'testnet', true)`, [id, STRAT]);
    expect(await getOpenPositionById(id)).toBeNull();
  });
});
