// Aritmética pura de precios/cantidades para el ejecutor real. Sin red, sin ccxt.

// Precio máximo aceptable de una entrada marketable (cap de slippage sobre refPrice).
export function capPrice(refPrice: number, slippageBps: number): number {
  return refPrice * (1 + slippageBps / 1e4);
}

// Precio límite de la leg STOP_LOSS_LIMIT: por debajo del trigger para que llene en una caída rápida.
export function stopLimitPrice(sl: number, offsetBps: number): number {
  return sl * (1 - offsetBps / 1e4);
}

export interface CcxtFee { cost?: number; currency?: string }

// Fee cobrado en la moneda base (0 si se pagó en quote o BNB). Lee order.fees[] o el único order.fee.
export function feeInBase(fees: CcxtFee[] | undefined, single: CcxtFee | undefined, base: string): number {
  const list = (fees && fees.length > 0) ? fees : (single ? [single] : []);
  return list.filter((f) => f.currency === base).reduce((sum, f) => sum + (f.cost ?? 0), 0);
}

// ¿La qty cumple los mínimos de la leg (cantidad y notional)?
export function meetsLegMin(qty: number, price: number, minAmount: number, minCost: number): boolean {
  return qty >= minAmount && qty * price >= minCost;
}
