import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './connection.ts';
import { EVALUATE_QUEUE, type EvaluateJobData } from './evaluate-queue.ts';
import { evaluateCandidate } from '../../workflows/evaluate-candidate.ts';

// Worker BullMQ: procesa cada candidato encolado con el orquestador determinista.
export function startEvaluateWorker(): Worker<EvaluateJobData> {
  // Cast necesario: getBullConnection() retorna IORedis del paquete top-level; ConnectionOptions
  // en BullMQ refiere al ioredis bundleado en bullmq/node_modules — mismo runtime, distinto path de tipos.
  const conn = getBullConnection() as unknown as ConnectionOptions;
  return new Worker<EvaluateJobData>(
    EVALUATE_QUEUE,
    async (job) => evaluateCandidate(job.data.signalId),
    { connection: conn, concurrency: 1 },
  );
}
