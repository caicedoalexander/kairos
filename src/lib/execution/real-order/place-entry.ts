// src/lib/execution/real-order/place-entry.ts
import { capPrice, feeInBase, meetsLegMin, type CcxtFee } from './precision.ts';

export interface EntryClient {
  market(symbol: string): { id: string; base: string; limits: { amount: { min?: number }; cost: { min?: number } } };
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  // `price` es number, alineado con la firma real de ccxt (`createOrder(symbol, type, side, amount, price?: number, params?)`).
  createOrder(symbol: string, type: string, side: string, amount: number, price: number, params: Record<string, unknown>): Promise<RawOrder>;
}
interface RawOrder { id: string; filled?: number; average?: number; fee?: CcxtFee; fees?: CcxtFee[] }

export interface PlaceEntryArgs { symbol: string; size: number; refPrice: number; slippageBps: number; clientOrderId: string }
// CONTRATO PARA EL CALLER (executeOrderReal, §18.3): `filledQty === 0` significa que la IOC
// no cruzó el book. El caller DEBE hacer early return en ese caso — NUNCA crear posición ni OCO
// con size 0; el size real de la posición sale siempre de los fills reales.
export type EntryResult =
  | { belowMin: true }
  | { belowMin: false; filledQty: number; avgPrice: number; fee: number; feeBase: number; exchangeOrderId: string };

// Entrada limit marketable IOC capada al peor precio aceptable. Devuelve el fill normalizado.
export async function placeEntry(client: EntryClient, a: PlaceEntryArgs): Promise<EntryResult> {
  const market = client.market(a.symbol);
  const cap = Number(client.priceToPrecision(a.symbol, capPrice(a.refPrice, a.slippageBps)));
  const amount = Number(client.amountToPrecision(a.symbol, a.size));
  // Mínimos del market sobre el refPrice (estimación pre-trade): no enviar polvo.
  if (!meetsLegMin(amount, a.refPrice, market.limits.amount.min ?? 0, market.limits.cost.min ?? 0)) {
    return { belowMin: true };
  }
  const order = await client.createOrder(a.symbol, 'limit', 'buy', amount, cap, { timeInForce: 'IOC', clientOrderId: a.clientOrderId });
  const filledQty = order.filled ?? 0;
  const totalFee = sumFee(order);
  return {
    belowMin: false,
    filledQty,
    avgPrice: order.average ?? 0,
    fee: totalFee,
    feeBase: feeInBase(order.fees, order.fee, market.base),
    exchangeOrderId: String(order.id),
  };
}

function sumFee(order: RawOrder): number {
  if (order.fees && order.fees.length > 0) return order.fees.reduce((s, f) => s + (f.cost ?? 0), 0);
  return order.fee?.cost ?? 0;
}

// FIX M1 (SP13): el P&L resta `fee`/`exitFee` como escalares en quote. Verificado contra ccxt:
// `order.fees[].cost` (por-trade) lleva su `commissionAsset` real, que puede ser BNB. El supuesto
// operativo de SP13 es "fees en quote (USDT)"; el smoke owner-gated verifica la moneda real en testnet
// y desactiva el descuento BNB si aparece. No se normaliza en código en SP13 (deuda declarada).
