import { getMode, type TradingMode } from '../mode.ts';
import { getOpenPositions, type OpenPosition } from '../../db/repositories/positions.ts';
import { getClosedCandlesAfter } from '../../db/repositories/ohlcv-candles.ts';
import { resolveBracket } from '../execution/bracket.ts';
import { closePositionOnBracket } from './close-position.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { sendWhatsApp } from '../../notify/whatsapp.ts';
import { notifyBestEffort } from '../../notify/best-effort.ts';
import type { SimParams, BarOHLC, BracketResolution } from '../execution/types.ts';

export interface MonitorTickDeps {
  getOpenPositions: (mode: TradingMode) => Promise<OpenPosition[]>;
  getBars: (symbol: string, timeframe: string, asOf: Date, openedAt: Date) => Promise<BarOHLC[]>;
  closeOnBracket: (position: OpenPosition, resolution: BracketResolution, closedAt: Date) => Promise<boolean>;
  notify: (text: string) => Promise<{ messageId: string | null }>;
  onError: (positionId: string, err: unknown) => Promise<void>;
  simParams: SimParams;
  mode: TradingMode;
}

export interface MonitorTickResult { checked: number; closed: number; }

const DEFAULT_DEPS: MonitorTickDeps = {
  getOpenPositions,
  getBars: async (symbol, timeframe, asOf, openedAt) => {
    // openedAt = límite inferior estricto (open_time > openedAt): excluye la vela de entrada
    // (anti-look-ahead §20). Las velas se devuelven en orden ascendente para resolución
    // barra-a-barra, igual que el replay del backtester.
    const candles = await getClosedCandlesAfter(symbol, timeframe, openedAt, asOf);
    return candles.map((c) => ({ open: c.o, high: c.h, low: c.l, close: c.c }));
  },
  closeOnBracket: closePositionOnBracket,
  notify: sendWhatsApp,
  onError: async (positionId, err) => {
    await appendAuditLog({ eventType: 'monitor_error', actor: 'monitor',
      payload: { positionId, error: err instanceof Error ? err.message : String(err) } });
  },
  simParams: DEFAULT_SIM_PARAMS,
  mode: getMode(),
};

// Resuelve una posición barra-a-barra: cierra en el primer hit (orden ascendente = primer hit
// cronológico), igual que el replay del backtester (anti-divergencia §20.1).
async function checkPosition(position: OpenPosition, asOf: Date, d: MonitorTickDeps): Promise<boolean> {
  const bars = await d.getBars(position.symbol, position.triggerTimeframe, asOf, position.openedAt);
  for (const bar of bars) {
    const resolution = resolveBracket(position, bar, d.simParams);
    if (!resolution) continue;
    if (!(await d.closeOnBracket(position, resolution, asOf))) return false;
    const icon = resolution.hitType === 'tp' ? '🟢' : '🔴';
    await notifyBestEffort(d.notify,
      `${icon} ${position.symbol}: salida ${resolution.hitType.toUpperCase()} @ ${resolution.exitPrice} (pnl ${resolution.realizedPnl})`,
      'monitor');
    return true;
  }
  return false;
}

// Un tick del monitor: cada posición abierta se resuelve aislada; un fallo se reporta y el tick sigue.
export async function runMonitorTick(asOf: Date, deps: Partial<MonitorTickDeps> = {}): Promise<MonitorTickResult> {
  const resolved = { ...DEFAULT_DEPS, ...deps };
  const positions = await resolved.getOpenPositions(resolved.mode);
  let checked = 0, closed = 0;
  for (const position of positions) {
    checked++;
    try {
      if (await checkPosition(position, asOf, resolved)) closed++;
    } catch (err: unknown) {
      try { await resolved.onError(position.id, err); } catch { /* último recurso: handler también falló */ }
    }
  }
  return { checked, closed };
}
