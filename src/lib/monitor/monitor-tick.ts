import { getMode, type TradingMode } from '../mode.ts';
import { getOpenPositions, type OpenPosition } from '../../db/repositories/positions.ts';
import { getLatestCandle } from '../../db/repositories/ohlcv-candles.ts';
import { resolveBracket } from '../execution/bracket.ts';
import { closePositionOnBracket } from './close-position.ts';
import { DEFAULT_SIM_PARAMS } from '../execution/limits.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import { sendWhatsApp } from '../../notify/whatsapp.ts';
import { notifyBestEffort } from '../../notify/best-effort.ts';
import type { SimParams, BarOHLC, BracketResolution } from '../execution/types.ts';

export interface MonitorTickDeps {
  getOpenPositions: (mode: TradingMode) => Promise<OpenPosition[]>;
  getBar: (symbol: string, timeframe: string, asOf: Date, openedAt: Date) => Promise<BarOHLC | null>;
  closeOnBracket: (position: OpenPosition, resolution: BracketResolution, closedAt: Date) => Promise<boolean>;
  notify: (text: string) => Promise<{ messageId: string | null }>;
  onError: (positionId: string, err: unknown) => Promise<void>;
  simParams: SimParams;
  mode: TradingMode;
}

export interface MonitorTickResult { checked: number; closed: number; }

const DEFAULT_DEPS: MonitorTickDeps = {
  getOpenPositions,
  getBar: async (symbol, timeframe, asOf, openedAt) => {
    // minOpenTime = openedAt: solo velas que abrieron DESPUÉS de la entrada (no resolver la vela
    // de entrada — convención anti-look-ahead del backtester, §20).
    const c = await getLatestCandle(symbol, timeframe, asOf, openedAt);
    return c ? { open: c.o, high: c.h, low: c.l, close: c.c } : null;
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

// Resuelve una posición: lee su última vela, resuelve el bracket y cierra+notifica si toca.
async function checkPosition(position: OpenPosition, asOf: Date, d: MonitorTickDeps): Promise<boolean> {
  const bar = await d.getBar(position.symbol, position.triggerTimeframe, asOf, position.openedAt);
  if (!bar) return false;
  const resolution = resolveBracket(position, bar, d.simParams);
  if (!resolution) return false;
  if (!(await d.closeOnBracket(position, resolution, asOf))) return false;
  const icon = resolution.hitType === 'tp' ? '🟢' : '🔴';
  await notifyBestEffort(d.notify,
    `${icon} ${position.symbol}: salida ${resolution.hitType.toUpperCase()} @ ${resolution.exitPrice} (pnl ${resolution.realizedPnl})`,
    'monitor');
  return true;
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
