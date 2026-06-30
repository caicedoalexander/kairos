import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getBullConnection, closeBullConnection } from './lib/queue/connection.ts';
import { startEvaluateWorker } from './lib/queue/evaluate-worker.ts';
import { closeEvaluateQueue } from './lib/queue/evaluate-queue.ts';
import { closeShadowQueue } from './lib/queue/shadow-queue.ts';
import { runScanTick } from './lib/scanner/scan-tick.ts';
import { runMonitorTick } from './lib/monitor/monitor-tick.ts';
import { pool } from './db/pool.ts';
import { createShutdown } from './lib/queue/shutdown.ts';
import { runStartupReconcile } from './lib/reconcile/startup-reconcile.ts';
import { closeSetupLockConnection } from './lib/execution/setup-lock.ts';
import { getMode } from './lib/mode.ts';
import { isRealMode } from './lib/execution/dispatch.ts';
import { runExchangeReconcile } from './lib/reconcile/exchange-reconcile.ts';
import { runMonitorTickReal } from './lib/monitor/monitor-real.ts';
import { refreshOhlcv } from './lib/market-data/refresh.ts';
import { getAuthenticatedClient } from './lib/ccxt-client.ts';
import { placeOco } from './lib/execution/real-order/place-oco.ts';
import { emergencyClose } from './lib/execution/real-order/emergency-close.ts';
import type { RealClient } from './lib/execution/execute-order-real.ts';
import type { OrderStateClient } from './lib/execution/real-order/order-state.ts';
import type { CancelOcoClient } from './lib/execution/real-order/cancel-oco.ts';
import type { PriceClient } from './lib/monitor/monitor-real.ts';
import { sendWhatsApp } from './notify/whatsapp.ts';
import { RECONCILE_INTERVAL_MS, OHLCV_REFRESH_INTERVAL_MS } from './lib/execution/limits.ts';

const SHUTDOWN_TIMEOUT_MS = 10 * 1000;

// L2: guarda contra valores no numéricos/no positivos en la env.
const parsedInterval = Number(process.env.SCAN_INTERVAL_MS);
const SCAN_INTERVAL_MS = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 15 * 60 * 1000;
const SCAN_QUEUE = 'scan-tick';

const parsedMonitor = Number(process.env.MONITOR_INTERVAL_MS);
const MONITOR_INTERVAL_MS = Number.isFinite(parsedMonitor) && parsedMonitor > 0 ? parsedMonitor : 60 * 1000;
const MONITOR_QUEUE = 'monitor-tick';

// Credenciales en closure: el modelo nunca ve las keys ni elige la cuenta (§líneas rojas).
// El cast es seguro en runtime: el cliente ccxt implementa RealClient & OrderStateClient & CancelOcoClient & PriceClient (SP12/SP13/trailing).
async function realDeps() {
  const client = getAuthenticatedClient();
  await client.loadMarkets();
  const real = client as unknown as (RealClient & OrderStateClient & CancelOcoClient & PriceClient);
  return { client: real, placeOco, emergencyClose, mode: getMode() };
}

async function main(): Promise<void> {
  const mode = getMode();
  if (isRealMode(mode)) {
    const rec = await runExchangeReconcile(await realDeps());
    process.stdout.write(`[worker] reconcile ccxt de arranque: ${rec.entries} entradas, ${rec.positions} posiciones\n`);
  } else {
    const recon = await runStartupReconcile();
    process.stdout.write(`[worker] reconcile de arranque (sim): ${recon.stuckEntries} entradas colgadas, ${recon.orphanedLegs} legs huérfanas\n`);
  }

  const evaluateWorker = startEvaluateWorker();

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

  const monitorWorker = new Worker(MONITOR_QUEUE, async () => {
    if (isRealMode(mode)) await runMonitorTickReal(new Date(), { ...(await realDeps()), notify: sendWhatsApp });
    else await runMonitorTick(new Date());
  }, { connection: conn, concurrency: 1 });
  monitorWorker.on('error', (err) => process.stderr.write(`[monitor-worker] error: ${err}\n`));
  monitorWorker.on('failed', (job, err) => process.stderr.write(`[monitor-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));

  const monitorQueue = new Queue(MONITOR_QUEUE, { connection: conn });
  await monitorQueue.upsertJobScheduler(
    'monitor-tick',
    { every: MONITOR_INTERVAL_MS },
    { name: 'tick', data: {}, opts: { removeOnComplete: true } },
  );

  // Ticks periódicos de reconcile ccxt y refresh OHLCV: solo en modo real (testnet/live).
  // En sim el reconcile delgado de arranque es suficiente; el refresh no aporta carga extra
  // útil sin un exchange real que responda (YAGNI para el loop sim).
  let reconcileQueue: Queue | undefined, refreshQueue: Queue | undefined;
  let reconcileWorker: Worker | undefined, refreshWorker: Worker | undefined;
  if (isRealMode(mode)) {
    // FIX L-2: el spec exige refresh ≤ monitor; si no, el scanner ve velas rancias entre ticks.
    if (OHLCV_REFRESH_INTERVAL_MS > MONITOR_INTERVAL_MS) {
      process.stderr.write(`[worker] WARN: OHLCV_REFRESH_INTERVAL_MS (${OHLCV_REFRESH_INTERVAL_MS}) > MONITOR_INTERVAL_MS (${MONITOR_INTERVAL_MS})\n`);
    }
    const RECONCILE_QUEUE = 'reconcile-tick';
    reconcileWorker = new Worker(RECONCILE_QUEUE, async () => { await runExchangeReconcile(await realDeps()); }, { connection: conn, concurrency: 1 });
    reconcileWorker.on('error', (err) => process.stderr.write(`[reconcile-worker] error: ${err}\n`));
    reconcileWorker.on('failed', (job, err) => process.stderr.write(`[reconcile-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));
    reconcileQueue = new Queue(RECONCILE_QUEUE, { connection: conn });
    await reconcileQueue.upsertJobScheduler('reconcile-tick', { every: RECONCILE_INTERVAL_MS }, { name: 'tick', data: {}, opts: { removeOnComplete: true } });

    const REFRESH_QUEUE = 'ohlcv-refresh-tick';
    refreshWorker = new Worker(REFRESH_QUEUE, async () => { await refreshOhlcv(); }, { connection: conn, concurrency: 1 });
    refreshWorker.on('error', (err) => process.stderr.write(`[refresh-worker] error: ${err}\n`));
    refreshWorker.on('failed', (job, err) => process.stderr.write(`[refresh-worker] job failed: ${err instanceof Error ? err.message : String(err)}\n`));
    refreshQueue = new Queue(REFRESH_QUEUE, { connection: conn });
    await refreshQueue.upsertJobScheduler('ohlcv-refresh-tick', { every: OHLCV_REFRESH_INTERVAL_MS }, { name: 'tick', data: {}, opts: { removeOnComplete: true } });
  }

  process.stdout.write(`[worker] arriba: evaluate-candidate + scan cada ${SCAN_INTERVAL_MS}ms + monitor cada ${MONITOR_INTERVAL_MS}ms\n`);

  const shutdown = createShutdown({
    // Incluye los Queue además de los Worker: cada Queue abre su propia conexión IORedis (duplicate);
    // cerrarlas evita conexiones colgadas. scanQueue/monitorQueue están en scope; la cola evaluate
    // es un singleton interno → se cierra vía closeEvaluateQueue.
    // Los closeables de reconcile/refresh son opcionales (solo existen en modo real).
    closeables: [scanWorker, evaluateWorker, monitorWorker, scanQueue, monitorQueue,
      { close: closeEvaluateQueue }, { close: closeShadowQueue }, { close: closeSetupLockConnection },
      ...[reconcileWorker, refreshWorker, reconcileQueue, refreshQueue].filter((c): c is Worker | Queue => c !== undefined)],
    closeConnection: closeBullConnection,
    closePool: () => pool.end(),
    exit: (code) => process.exit(code),
    log: (msg) => process.stdout.write(`[worker] ${msg}\n`),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; },
  });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

main().catch((err) => { process.stderr.write(`[worker] fatal: ${err}\n`); process.exit(1); });
