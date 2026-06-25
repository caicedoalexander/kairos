import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';
import { pool } from './pool.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Aplica el esquema de dominio kairos (idempotente). Las flue_* las migra Flue al arrancar.
export async function migrate(): Promise<void> {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Entrypoint CLI: `npm run migrate`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Migración fallida:', error);
      process.exit(1);
    });
}
