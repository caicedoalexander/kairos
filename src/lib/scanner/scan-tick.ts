import { getEnabledStrategies } from '../../db/repositories/strategies.ts';
import { scanSymbol } from './scan-symbol.ts';
import { enqueueEvaluateCandidate } from '../queue/evaluate-queue.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import type { Strategy } from './types.ts';

export interface ScanTickDeps {
  getStrategies: () => Promise<Strategy[]>;
  scan: (strategy: Strategy, symbol: string, asOf: Date) => Promise<string | null>;
  enqueue: (signalId: string) => Promise<void>;
  onError: (strategyId: string, symbol: string, err: unknown) => Promise<void>;
}

export interface ScanTickResult { scanned: number; fired: number; enqueued: number; }

const DEFAULT_DEPS: ScanTickDeps = {
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
};

// Un tick determinista del scanner. Un fallo por símbolo se aísla (onError) y el tick continúa.
export async function runScanTick(asOf: Date, deps: Partial<ScanTickDeps> = {}): Promise<ScanTickResult> {
  const { getStrategies, scan, enqueue, onError } = { ...DEFAULT_DEPS, ...deps };
  const strategies = await getStrategies();
  let scanned = 0, fired = 0, enqueued = 0;

  for (const strategy of strategies) {
    for (const symbol of strategy.symbols) {
      scanned++;
      try {
        const signalId = await scan(strategy, symbol, asOf);
        if (!signalId) continue;
        fired++;
        await enqueue(signalId);
        enqueued++;
      } catch (err: unknown) {
        await onError(strategy.id, symbol, err);
      }
    }
  }

  return { scanned, fired, enqueued };
}
