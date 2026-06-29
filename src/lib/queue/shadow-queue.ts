import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './connection.ts';

export const SHADOW_QUEUE = 'shadow-eval';

export interface ShadowJobData { signalId: string; }
export interface ShadowJobSpec {
  name: string;
  data: ShadowJobData;
  opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
}

// Puro y testeable: jobId = signalId → BullMQ ignora duplicados con el mismo id.
// La guarda está aquí (y no en enqueueShadowEval) para que sea comprobable sin Redis.
export function buildShadowJob(signalId: string): ShadowJobSpec {
  if (!signalId) throw new Error('signalId requerido para encolar shadow-eval');
  return { name: 'shadow', data: { signalId }, opts: { jobId: signalId, removeOnComplete: true, removeOnFail: false } };
}

let queue: Queue<ShadowJobData> | null = null;
function getQueue(): Queue<ShadowJobData> {
  if (!queue) {
    // BullMQ bundlea su propia copia de ioredis; el cast resuelve el conflicto nominal entre paths.
    const conn = getBullConnection() as unknown as ConnectionOptions;
    queue = new Queue(SHADOW_QUEUE, { connection: conn });
  }
  return queue;
}

export async function enqueueShadowEval(signalId: string): Promise<void> {
  const spec = buildShadowJob(signalId);
  await getQueue().add(spec.name, spec.data, spec.opts);
}

export async function closeShadowQueue(): Promise<void> {
  if (queue) { await queue.close(); queue = null; }
}
