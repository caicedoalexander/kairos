import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { invoke } from '@flue/runtime';
import { getBullConnection } from '../lib/queue/connection.ts';
import { SHADOW_QUEUE, type ShadowJobData } from '../lib/queue/shadow-queue.ts';
import decisionMaker from '../workflows/decision-maker.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Worker del runtime Flue: admite el run del decision-maker (fire-and-forget). invoke() solo
// funciona dentro del servidor Flue, por eso este worker vive en app.ts (no en worker.ts).
// Guardado: solo arranca cuando se configura explícitamente (no durante build/test).
export function startShadowWorker(): Worker<ShadowJobData> | null {
  if (process.env.SHADOW_WORKER !== 'on') return null;
  const conn = getBullConnection() as unknown as ConnectionOptions;
  const w = new Worker<ShadowJobData>(
    SHADOW_QUEUE,
    async (job) => { await invoke(decisionMaker, { input: { signalId: job.data.signalId } }); },
    { connection: conn, concurrency: 1 },
  );
  w.on('error', (err) => process.stderr.write(`[shadow-worker] error: ${err}\n`));
  w.on('failed', (job, err) => {
    void appendAuditLog({ eventType: 'shadow_admit_failed', actor: 'shadow-worker',
      payload: { signalId: job?.data?.signalId ?? null, error: err instanceof Error ? err.message : String(err) } }).catch(() => {});
  });
  return w;
}
