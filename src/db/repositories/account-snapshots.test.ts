import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from '../migrate.ts';
import { pool, query } from '../pool.ts';
import { appendSnapshot, getLatestSnapshot, ensureInitialSnapshot } from './account-snapshots.ts';

const SENT_APPEND = 99002;   // equity centinela improbable, para limpieza aislada
const SENT_INITIAL = 99003;

beforeAll(async () => { await migrate(); });
afterAll(async () => {
  await query('DELETE FROM kairos.account_snapshots WHERE equity IN ($1, $2)', [SENT_APPEND, SENT_INITIAL]);
  await pool.end();
});

describe('account-snapshots', () => {
  test('appendSnapshot inserta y se relee por id', async () => {
    const snap = await appendSnapshot({ equity: SENT_APPEND, peakEquity: SENT_APPEND, drawdown: 0, dailyPnl: 0 });
    const rows = await query<{ equity: string }>('SELECT equity FROM kairos.account_snapshots WHERE id = $1', [snap.id]);
    expect(Number(rows[0].equity)).toBe(SENT_APPEND);
  });

  test('getLatestSnapshot devuelve una fila con forma válida tras un append', async () => {
    await appendSnapshot({ equity: SENT_APPEND, peakEquity: SENT_APPEND, drawdown: 1.5, dailyPnl: -10 });
    const latest = await getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(typeof latest!.equity).toBe('number');
    expect(typeof latest!.drawdown).toBe('number');
  });

  test('ensureInitialSnapshot garantiza al menos un snapshot', async () => {
    await ensureInitialSnapshot(SENT_INITIAL);
    expect(await getLatestSnapshot()).not.toBeNull();
  });
});
