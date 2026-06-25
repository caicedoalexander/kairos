import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Aplica el esquema de dominio kairos (idempotente). Las flue_* las migra Flue al arrancar.
export async function migrate(): Promise<void> {
  const { pool } = await import('./pool.ts');
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Entrypoint CLI: `npm run migrate`.
// v8 ignore next 11 — bloque de arranque CLI; no se puede unit-testear sin invocar el proceso
// como entrypoint directo. Se valida con `npm run migrate` en Fase 0 (ver task-8-brief.md).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // Carga .env solo cuando se invoca directamente como CLI, no al importar como módulo.
  await import('dotenv/config');
  const { pool } = await import('./pool.ts');
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Migración fallida:', error);
      process.exit(1);
    });
}
