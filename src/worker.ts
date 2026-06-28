import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection } from './lib/queue/connection.ts';
import { startEvaluateWorker } from './lib/queue/evaluate-worker.ts';
import { runScanTick } from './lib/scanner/scan-tick.ts';
import { runMonitorTick } from './lib/monitor/monitor-tick.ts';

// L2: guarda contra valores no numéricos/no positivos en la env.
const parsedInterval = Number(process.env.SCAN_INTERVAL_MS);
const SCAN_INTERVAL_MS = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 15 * 60 * 1000;
const SCAN_QUEUE = 'scan-tick';

const parsedMonitor = Number(process.env.MONITOR_INTERVAL_MS);
const MONITOR_INTERVAL_MS = Number.isFinite(parsedMonitor) && parsedMonitor > 0 ? parsedMonitor : 60 * 1000;
const MONITOR_QUEUE = 'monitor-tick';

async function main(): Promise<void> {
  startEvaluateWorker();

  // H1: Worker importado top-level (no dynamic import) para que tsc tipe el constructor.
  // Cast necesario: ver evaluate-worker.ts — mismo motivo (ioredis bundleado vs top-level).
  const conn = getBullConnection() as unknown as ConnectionOptions;

  // Worker del scan: cada tick recorre estrategias y encola candidatos.
  const scanWorker = new Worker(SCAN_QUEUE, async () => { await runScanTick(new Date()); }, { connection: conn, concurrency: 1 });
  // Previene "Unhandled error event" fatal en blips de conexión a Redis.
  scanWorker.on('error', (err) => process.stderr.write(`[scan-worker] error: ${err}\n`));
  // Alarma de infra: runScanTick audita sus errores por símbolo internamente; este listener
  // es defensa adicional para throws que escapen del handler (p.ej. getStrategies falla total).
  scanWorker.on('failed', (job, err) => process.stderr.write(`[scan-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));

  // M2: upsertJobScheduler es la API idempotente de BullMQ v5 para jobs repetibles.
  // Firma verificada en node_modules/bullmq/dist/esm/classes/queue.d.ts:193:
  //   upsertJobScheduler(jobSchedulerId, repeatOpts, jobTemplate?) => Promise<Job>
  const scanQueue = new Queue(SCAN_QUEUE, { connection: conn });
  await scanQueue.upsertJobScheduler(
    'scan-tick',
    { every: SCAN_INTERVAL_MS },
    { name: 'tick', data: {}, opts: { removeOnComplete: true } },
  );

  const monitorWorker = new Worker(MONITOR_QUEUE, async () => { await runMonitorTick(new Date()); }, { connection: conn, concurrency: 1 });
  monitorWorker.on('error', (err) => process.stderr.write(`[monitor-worker] error: ${err}\n`));
  monitorWorker.on('failed', (job, err) => process.stderr.write(`[monitor-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));

  const monitorQueue = new Queue(MONITOR_QUEUE, { connection: conn });
  await monitorQueue.upsertJobScheduler(
    'monitor-tick',
    { every: MONITOR_INTERVAL_MS },
    { name: 'tick', data: {}, opts: { removeOnComplete: true } },
  );

  process.stdout.write(`[worker] arriba: evaluate-candidate + scan cada ${SCAN_INTERVAL_MS}ms + monitor cada ${MONITOR_INTERVAL_MS}ms\n`);
}

main().catch((err) => { process.stderr.write(`[worker] fatal: ${err}\n`); process.exit(1); });
