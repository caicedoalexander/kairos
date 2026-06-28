import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './connection.ts';
import { EVALUATE_QUEUE, type EvaluateJobData } from './evaluate-queue.ts';
import { evaluateCandidate } from '../../workflows/evaluate-candidate.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';

// Worker BullMQ: procesa cada candidato encolado con el orquestador determinista.
export function startEvaluateWorker(): Worker<EvaluateJobData> {
  // Cast necesario: getBullConnection() retorna IORedis del paquete top-level; ConnectionOptions
  // en BullMQ refiere al ioredis bundleado en bullmq/node_modules — mismo runtime, distinto path de tipos.
  const conn = getBullConnection() as unknown as ConnectionOptions;
  const w = new Worker<EvaluateJobData>(
    EVALUATE_QUEUE,
    async (job) => evaluateCandidate(job.data.signalId),
    { connection: conn, concurrency: 1 },
  );
  // Previene "Unhandled error event" fatal en blips de conexión a Redis.
  w.on('error', (err) => process.stderr.write(`[evaluate-worker] error: ${err}\n`));
  // Audita fallos de job a kairos.audit_log — throws dentro del handler mueven el job a `failed`
  // sin rastro; el .catch(() => {}) evita que un fallo de DB (mismo que pudo causar el job a fallar)
  // tire el proceso con un unhandled rejection.
  w.on('failed', (job, err) => {
    void appendAuditLog({
      eventType: 'evaluate_job_failed',
      actor: 'evaluate-worker',
      payload: { signalId: job?.data?.signalId ?? null, error: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
  });
  return w;
}
