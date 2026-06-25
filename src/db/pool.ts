import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no está configurada');
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Helper de solo-lectura/escritura simple sobre el pool (los repos lo reutilizan).
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(text, params as never);
  return result.rows as T[];
}
