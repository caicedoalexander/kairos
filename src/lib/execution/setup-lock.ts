import IORedis from 'ioredis';
import { ulid } from 'ulidx';
import type { TradingMode } from '../mode.ts';
import { SETUP_LOCK_TTL_MS } from './limits.ts';

// Lock de mutua exclusión por SETUP (no por señal): el dedup de Kairos es per-setup. Fail-closed pronto.
export const NOT_ACQUIRED = { lock: 'not_acquired' } as const;
export type NotAcquired = typeof NOT_ACQUIRED;

export interface LockClient {
  set(key: string, value: string, ttlMode: 'PX', ttl: number, nxMode: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

let shared: IORedis | null = null;
function defaultClient(): LockClient {
  if (shared) return shared as unknown as LockClient;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL no configurada (lock de setup)');
  // Fail-closed PRONTO: con enableOfflineQueue:false el cliente rechaza inmediatamente
  // en lugar de encolar comandos cuando Redis está caído; maxRetriesPerRequest:1 evita
  // reintentos de ioredis que demorarían el rechazo; commandTimeout:5000 es un techo duro.
  // Resultado: un outage de Redis produce un reject rápido → el fail-closed documentado
  // es real (el caller no ejecuta sin lock), no un cuelgue silencioso.
  // (No se puede unit-testear el cuelgue sin un Redis real caído; el test de fail-closed
  // existente cubre el comportamiento observable: set lanza → fn no se ejecuta.)
  shared = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 5000 });
  return shared as unknown as LockClient;
}

// Libera sólo si el valor sigue siendo mío (check-and-del atómico).
const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function withSetupLock<T>(
  strategyId: string, symbol: string, mode: TradingMode,
  fn: () => Promise<T>, opts: { client?: LockClient } = {},
): Promise<T | NotAcquired> {
  const client = opts.client ?? defaultClient();
  const key = `kairos:lock:setup:${strategyId}:${symbol}:${mode}`;
  const token = ulid();
  // Fail-closed: si SET lanza (Redis caído), propaga — NO ejecutamos sin lock.
  const acquired = await client.set(key, token, 'PX', SETUP_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') return NOT_ACQUIRED;
  try {
    return await fn();
  } finally {
    try { await client.eval(RELEASE_LUA, 1, key, token); } catch { /* best-effort; el TTL lo limpia */ }
  }
}

// Cierra la conexión singleton del lock (REDIS_URL) en el graceful shutdown; espeja closeBullConnection.
export async function closeSetupLockConnection(): Promise<void> {
  if (shared) { await shared.quit(); shared = null; }
}
