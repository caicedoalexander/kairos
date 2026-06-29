import { query, type Executor } from '../pool.ts';

const SINGLETON = 'singleton';

// Lee el flag de pausa global (default false si la fila no existe).
export async function getPaused(exec: Executor = query): Promise<boolean> {
  const rows = await exec<{ paused: boolean }>(`SELECT paused FROM kairos.bot_state WHERE id = $1`, [SINGLETON]);
  return rows[0]?.paused ?? false;
}

// Upsert del singleton: pausa/reanuda el bot. Idempotente.
export async function setPaused(paused: boolean, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.bot_state (id, paused, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = now()`,
    [SINGLETON, paused],
  );
}
