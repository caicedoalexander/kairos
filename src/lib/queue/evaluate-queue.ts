import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './connection.ts';

export const EVALUATE_QUEUE = 'evaluate-candidate';

export interface EvaluateJobData { signalId: string; }
export interface EvaluateJobSpec {
  name: string;
  data: EvaluateJobData;
  opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
}

// Puro y testeable: jobId = signalId → BullMQ ignora duplicados con el mismo id.
// La guarda está aquí (y no en enqueueEvaluateCandidate) para que sea comprobable sin Redis.
export function buildEvaluateJob(signalId: string): EvaluateJobSpec {
  if (!signalId) throw new Error('signalId requerido para encolar evaluate-candidate');
  return {
    name: 'evaluate',
    data: { signalId },
    opts: { jobId: signalId, removeOnComplete: true, removeOnFail: false },
  };
}

let queue: Queue<EvaluateJobData> | null = null;
function getQueue(): Queue<EvaluateJobData> {
  if (!queue) {
    // BullMQ 5 bundlea su propia copia de ioredis (5.10.x) mientras que el proyecto
    // usa la copia top-level (5.11.x). Ambas versiones son API-compatibles en runtime;
    // el cast resuelve el conflicto nominal entre los dos paths de módulo.
    const conn = getBullConnection() as unknown as ConnectionOptions;
    queue = new Queue(EVALUATE_QUEUE, { connection: conn });
  }
  return queue;
}

export async function enqueueEvaluateCandidate(signalId: string): Promise<void> {
  const spec = buildEvaluateJob(signalId);
  await getQueue().add(spec.name, spec.data, spec.opts);
}

export async function closeEvaluateQueue(): Promise<void> {
  if (queue) { await queue.close(); queue = null; }
}
