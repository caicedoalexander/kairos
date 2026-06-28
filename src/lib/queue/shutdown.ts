export interface Closeable { close: () => Promise<void>; }

export interface ShutdownDeps {
  closeables: Closeable[];
  closeConnection: () => Promise<void>;
  closePool: () => Promise<void>;
  exit: (code: number) => void;
  log: (msg: string) => void;
  timeoutMs: number;
  setTimer: (fn: () => void, ms: number) => { clear: () => void };
}

// Apagado idempotente: cierra workers/queues (terminan el job en vuelo y dejan de tomar nuevos),
// la conexión Redis y el pool PG. Un timer de gracia fuerza exit(1) si algún close cuelga.
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    deps.log('apagando: cerrando workers y conexiones...');
    const timer = deps.setTimer(() => { deps.log('timeout de apagado, forzando exit'); deps.exit(1); }, deps.timeoutMs);
    try {
      for (const c of deps.closeables) await c.close();
      await deps.closeConnection();
      await deps.closePool();
      timer.clear();
      deps.log('apagado limpio');
      deps.exit(0);
    } catch (err: unknown) {
      timer.clear();
      deps.log(`error en apagado: ${err instanceof Error ? err.message : String(err)}`);
      deps.exit(1);
    }
  };
}
