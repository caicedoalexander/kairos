import type { GatheredState } from '../execution/check-risk.ts';
import type { Ledger, OpenPosition, ClosedTrade, TradeClose } from './types.ts';

export function emptyLedger(startingEquity: number): Ledger {
  return { startingEquity, realized: 0, peakEquity: startingEquity, open: null, trades: [] };
}

function unrealized(open: OpenPosition | null, markPrice: number): number {
  if (!open) return 0;
  return (markPrice - open.entry) * open.size - open.entryFee;
}

export function markToMarket(l: Ledger, markPrice: number): number {
  return l.startingEquity + l.realized + unrealized(l.open, markPrice);
}

export function markEquity(l: Ledger, markPrice: number): Ledger {
  const eq = markToMarket(l, markPrice);
  return eq > l.peakEquity ? { ...l, peakEquity: eq } : l;
}

export function applyOpen(l: Ledger, pos: OpenPosition): Ledger {
  return { ...l, open: pos };
}

export function applyClose(l: Ledger, close: TradeClose, openedAt: Date, closedAt: Date): Ledger {
  if (!l.open) throw new Error('applyClose sin posición abierta');
  const open = l.open;
  const riskPerUnit = open.entry - open.sl;
  const rMultiple = riskPerUnit > 0 ? close.realizedPnl / (riskPerUnit * open.size) : 0;
  const trade: ClosedTrade = {
    openedAt, closedAt, entry: open.entry, exit: close.exitPrice, size: open.size,
    fees: open.entryFee + close.exitFee, realizedPnl: close.realizedPnl, hitType: close.hitType, rMultiple,
  };
  return { ...l, realized: l.realized + close.realizedPnl, open: null, trades: [...l.trades, trade] };
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

export function gatherState(l: Ledger, T: Date, markPrice: number): GatheredState {
  const equity = markToMarket(l, markPrice);
  const drawdownPct = l.peakEquity > 0 ? Math.max(0, ((l.peakEquity - equity) / l.peakEquity) * 100) : 0;
  const dailyPnl = l.trades
    .filter((t) => sameUtcDay(t.closedAt, T))
    .reduce((a, t) => a + t.realizedPnl, 0);
  let consecutiveLosses = 0;
  for (let i = l.trades.length - 1; i >= 0; i--) {
    if (l.trades[i].realizedPnl < 0) consecutiveLosses++;
    else break;
  }
  const notional = l.open ? l.open.entry * l.open.size : 0;
  return {
    equity, drawdownPct, dailyPnl,
    openNotionalTotal: notional, openNotionalSymbol: notional,
    openPositionsCount: l.open ? 1 : 0, consecutiveLosses,
  };
}
