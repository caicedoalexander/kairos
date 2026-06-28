import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './lib/queue/connection.ts';
import { startEvaluateWorker } from './lib/queue/evaluate-worker.ts';
import { runScanTick } from './lib/scanner/scan-tick.ts';

// L2: guarda contra valores no numéricos/no positivos en la env.
const parsedInterval = Number(process.env.SCAN_INTERVAL_MS);
const SCAN_INTERVAL_MS = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 15 * 60 * 1000;
const SCAN_QUEUE = 'scan-tick';

async function main(): Promise<void> {
  startEvaluateWorker();

  // H1: Worker importado top-level (no dynamic import) para que tsc tipe el constructor.
  // Cast necesario: ver evaluate-worker.ts — mismo motivo (ioredis bundleado vs top-level).
  const conn = getBullConnection() as unknown as ConnectionOptions;

  // Worker del scan: cada tick recorre estrategias y encola candidatos.
  new Worker(SCAN_QUEUE, async () => { await runScanTick(new Date()); }, { connection: conn, concurrency: 1 });

  // M2: upsertJobScheduler es la API idempotente de BullMQ v5 para jobs repetibles.
  // Firma verificada en node_modules/bullmq/dist/esm/classes/queue.d.ts:193:
  //   upsertJobScheduler(jobSchedulerId, repeatOpts, jobTemplate?) => Promise<Job>
  const scanQueue = new Queue(SCAN_QUEUE, { connection: conn });
  await scanQueue.upsertJobScheduler(
    'scan-tick',
    { every: SCAN_INTERVAL_MS },
    { name: 'tick', data: {}, opts: { removeOnComplete: true } },
  );

  process.stdout.write(`[worker] arriba: evaluate-candidate + scan cada ${SCAN_INTERVAL_MS}ms\n`);
}

main().catch((err) => { process.stderr.write(`[worker] fatal: ${err}\n`); process.exit(1); });
