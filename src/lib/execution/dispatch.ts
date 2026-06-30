import type { TradingMode } from '../mode.ts';

// Un modo es "real" si toca el exchange (testnet o live). sim usa caminos sintéticos.
// Centraliza el despacho por modo del reconciler/monitor (SP13).
export function isRealMode(mode: TradingMode): boolean {
  return mode === 'testnet' || mode === 'live';
}
