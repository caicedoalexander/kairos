import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está configurada');
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type QueryParam = string | number | boolean | null | Date;

// Helper de solo-lectura/escritura simple sobre el pool (los repos lo reutilizan).
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: QueryParam[],
): Promise<T[]> {
  const result = await pool.query(text, params ?? []);
  return result.rows as T[];
}

export type Executor = <T = Record<string, unknown>>(
  text: string,
  params?: QueryParam[],
) => Promise<T[]>;

// Transacción de dominio: agrupa varios INSERT/UPDATE en un BEGIN/COMMIT.
// El callback recibe un `exec` ligado al client transaccional. Rollback ante throw.
export async function withTransaction<T>(fn: (exec: Executor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exec: Executor = async (text, params) => {
      const result = await client.query(text, params ?? []);
      return result.rows;
    };
    const out = await fn(exec);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
