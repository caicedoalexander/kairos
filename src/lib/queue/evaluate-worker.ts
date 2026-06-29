import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './connection.ts';
import { EVALUATE_QUEUE, type EvaluateJobData } from './evaluate-queue.ts';
import { evaluateCandidate } from '../../orchestration/evaluate-candidate.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { enqueueShadowEval } from './shadow-queue.ts';

// Worker BullMQ: procesa cada candidato encolado con el orquestador determinista.
export function startEvaluateWorker(): Worker<EvaluateJobData> {
  // Cast necesario: getBullConnection() retorna IORedis del paquete top-level; ConnectionOptions
  // en BullMQ refiere al ioredis bundleado en bullmq/node_modules — mismo runtime, distinto path de tipos.
  const conn = getBullConnection() as unknown as ConnectionOptions;
  const w = new Worker<EvaluateJobData>(
    EVALUATE_QUEUE,
    async (job) => {
      await evaluateCandidate(job.data.signalId);
      // Shadow eval (Fase 2, SP7): best-effort, fuera del camino del dinero. Un fallo aquí se
      // audita y se traga; el job del money path ya completó su trabajo determinista.
      try {
        await enqueueShadowEval(job.data.signalId);
      } catch (err: unknown) {
        void appendAuditLog({
          eventType: 'shadow_enqueue_failed',
          actor: 'evaluate-worker',
          payload: { signalId: job.data.signalId, error: err instanceof Error ? err.message : String(err) },
        }).catch(() => {});
      }
    },
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
