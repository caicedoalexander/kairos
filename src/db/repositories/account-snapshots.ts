import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface AccountSnapshotInput { equity: number; peakEquity: number; drawdown: number; dailyPnl: number; }
export interface AccountSnapshot extends AccountSnapshotInput { id: string; }

export async function appendSnapshot(s: AccountSnapshotInput, exec: Executor = query): Promise<AccountSnapshot> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.account_snapshots (id, equity, peak_equity, drawdown, daily_pnl)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, s.equity, s.peakEquity, s.drawdown, s.dailyPnl],
  );
  return { id, ...s };
}

export async function getLatestSnapshot(exec: Executor = query): Promise<AccountSnapshot | null> {
  const rows = await exec<{ id: string; equity: string; peak_equity: string; drawdown: string; daily_pnl: string }>(
    `SELECT id, equity, peak_equity, drawdown, daily_pnl
       FROM kairos.account_snapshots ORDER BY ts DESC LIMIT 1`,
  );
  const r = rows[0];
  return r ? { id: r.id, equity: Number(r.equity), peakEquity: Number(r.peak_equity), drawdown: Number(r.drawdown), dailyPnl: Number(r.daily_pnl) } : null;
}

// Siembra la equity de arranque del sim si aún no hay ningún snapshot (bootstrap del loop, SP5).
export async function ensureInitialSnapshot(startingEquity: number, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.account_snapshots (id, equity, peak_equity, drawdown, daily_pnl)
     SELECT $1, $2, $2, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM kairos.account_snapshots)`,
    [ulid(), startingEquity],
  );
}
