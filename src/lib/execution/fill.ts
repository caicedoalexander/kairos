import type { SimParams, FillResult } from './types.ts';

// paper-sim: precio de llenado SIEMPRE peor que el mid (§10/§18.2). Determinista.
export function simulateFill(
  side: 'buy' | 'sell', size: number, referencePrice: number, simParams: SimParams,
): FillResult {
  const slippageBps = simParams.spread_bps / 2 + simParams.slippage_bps;
  const adverse = slippageBps / 1e4;
  const fillPrice = side === 'buy'
    ? referencePrice * (1 + adverse)   // comprar más caro
    : referencePrice * (1 - adverse);  // vender más barato
  const fee = fillPrice * size * (simParams.fee_bps / 1e4);
  return { fillPrice, qty: size, fee, slippageBps };
}
