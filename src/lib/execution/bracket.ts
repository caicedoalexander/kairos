import { simulateFill } from './fill.ts';
import type { SimParams, PositionForResolve, BarOHLC, BracketResolution } from './types.ts';

// Resolución pura del bracket OCO en sim. La conduce SP4 (replay) / SP5 (monitor).
// Convención honesta (§20): SL primero si la vela toca ambos; SL=market con slippage y
// gap-through; TP=limit exacto sin slippage favorable.
export function resolveBracket(
  position: PositionForResolve, bar: BarOHLC, simParams: SimParams,
): BracketResolution | null {
  const hitSl = bar.low <= position.sl;
  const hitTp = bar.high >= position.tp;
  if (!hitSl && !hitTp) return null;

  if (hitSl) {
    const ref = Math.min(position.sl, bar.open);   // gap-through: si abre debajo del SL, llena al open
    const exit = simulateFill('sell', position.size, ref, simParams);
    const realizedPnl = (exit.fillPrice - position.entry) * position.size - position.entryFee - exit.fee;
    return { hitType: 'sl', exitPrice: exit.fillPrice, exitFee: exit.fee, realizedPnl };
  }

  const exitFee = position.tp * position.size * (simParams.fee_bps / 1e4);  // TP=limit exacto
  const realizedPnl = (position.tp - position.entry) * position.size - position.entryFee - exitFee;
  return { hitType: 'tp', exitPrice: position.tp, exitFee, realizedPnl };
}
