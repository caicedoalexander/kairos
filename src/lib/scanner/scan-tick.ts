import { getEnabledStrategies } from '../../db/repositories/strategies.ts';
import { getPaused } from '../../db/repositories/bot-state.ts';
import { scanSymbol } from './scan-symbol.ts';
import { enqueueEvaluateCandidate } from '../queue/evaluate-queue.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import type { Strategy } from './types.ts';

export interface ScanTickDeps {
  /** Kill-switch: si true, el tick no dispara (optimización: evita encolar). Default getPaused. */
  isPaused: () => Promise<boolean>;
  getStrategies: () => Promise<Strategy[]>;
  scan: (strategy: Strategy, symbol: string, asOf: Date) => Promise<string | null>;
  enqueue: (signalId: string) => Promise<void>;
  onError: (strategyId: string, symbol: string, err: unknown) => Promise<void>;
  /** Se llama cuando `enqueue` falla después de que `scan` ya persistió la señal. */
  onEnqueueError: (strategyId: string, symbol: string, signalId: string, err: unknown) => Promise<void>;
}

export interface ScanTickResult { scanned: number; fired: number; enqueued: number; }

const DEFAULT_DEPS: ScanTickDeps = {
  isPaused: getPaused,
  getStrategies: getEnabledStrategies,
  scan: scanSymbol,
  enqueue: enqueueEvaluateCandidate,
  // El default audita a kairos.audit_log (toca DB en prod).
  // Los tests unitarios inyectan onError: vi.fn() para no depender de Postgres.
  onError: async (strategyId, symbol, err) => {
    await appendAuditLog({
      eventType: 'scan_error',
      actor: 'scan_tick',
      payload: { strategyId, symbol, error: err instanceof Error ? err.message : String(err) },
    });
  },
  // Fallo de cola: la señal ya quedó en kairos.signals (status fired).
  // Se audita con eventType distinto para no confundirlo con un error de scan.
  onEnqueueError: async (strategyId, symbol, signalId, err) => {
    await appendAuditLog({
      eventType: 'enqueue_error',
      actor: 'scan_tick',
      payload: { strategyId, symbol, signalId, error: err instanceof Error ? err.message : String(err) },
    });
  },
};

interface SymbolResult { fired: number; enqueued: number; }

/** Procesa un símbolo aislando scan y enqueue en handlers separados. */
async function processSymbol(
  strategy: Strategy,
  symbol: string,
  asOf: Date,
  deps: ScanTickDeps,
): Promise<SymbolResult> {
  let signalId: string | null;
  try {
    signalId = await deps.scan(strategy, symbol, asOf);
  } catch (err: unknown) {
    // Fallo de scan: aísla el símbolo, el tick continúa con el resto.
    try { await deps.onError(strategy.id, symbol, err); } catch { /* último recurso: handler también falló */ }
    return { fired: 0, enqueued: 0 };
  }

  if (!signalId) return { fired: 0, enqueued: 0 };

  // La señal ya está persistida en kairos.signals. Si enqueue falla, fired sube
  // pero enqueued no — desajuste informativo que el reconciler (SP6) resolverá.
  try {
    await deps.enqueue(signalId);
    return { fired: 1, enqueued: 1 };
  } catch (err: unknown) {
    try { await deps.onEnqueueError(strategy.id, symbol, signalId, err); } catch { /* último recurso */ }
    return { fired: 1, enqueued: 0 };
  }
}

// Un tick determinista del scanner. Scan y enqueue tienen handlers separados;
// un fallo en cualquiera se aísla por símbolo y el tick continúa.
export async function runScanTick(asOf: Date, deps: Partial<ScanTickDeps> = {}): Promise<ScanTickResult> {
  const resolved = { ...DEFAULT_DEPS, ...deps };

  if (await resolved.isPaused()) {
    try {
      await appendAuditLog({ eventType: 'scan_paused', actor: 'scan_tick', payload: { asOf: asOf.toISOString() } });
    } catch { /* best-effort */ }
    return { scanned: 0, fired: 0, enqueued: 0 };
  }

  const strategies = await resolved.getStrategies();
  let scanned = 0, fired = 0, enqueued = 0;

  for (const strategy of strategies) {
    for (const symbol of strategy.symbols) {
      scanned++;
      const result = await processSymbol(strategy, symbol, asOf, resolved);
      fired += result.fired;
      enqueued += result.enqueued;
    }
  }

  return { scanned, fired, enqueued };
}
