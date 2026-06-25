import { postgres } from '@flue/postgres';
import { pool } from './db/pool.ts';

// Store de Flue (tablas flue_*): comparte el mismo pool que el dominio (esquema kairos).
// migrate() de Flue corre solo al arrancar el server Node y crea las flue_* idempotentemente.
export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async (text, params) => (await client.query(text, params)).rows,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
