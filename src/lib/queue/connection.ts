import IORedis from 'ioredis';

let conn: IORedis | null = null;

// Conexión singleton para BullMQ. maxRetriesPerRequest:null es requisito de BullMQ.
export function getBullConnection(): IORedis {
  if (conn) return conn;
  const url = process.env.REDIS_BULLMQ_URL;
  if (!url) throw new Error('REDIS_BULLMQ_URL no configurada');
  conn = new IORedis(url, { maxRetriesPerRequest: null });
  return conn;
}

export async function closeBullConnection(): Promise<void> {
  if (conn) { await conn.quit(); conn = null; }
}
