import type { CcxtFee } from './precision.ts';

export interface EmergencyClient {
  market(symbol: string): { base: string };
  createMarketSellOrder(symbol: string, amount: number): Promise<RawExit>;
}
interface RawExit { id: string; average?: number; fee?: CcxtFee; fees?: CcxtFee[] }

export interface EmergencyArgs { symbol: string; qty: number }
export interface ExitResult { exitPrice: number; exitFee: number; exchangeOrderId: string }

// Aplana una posición real (market IOC). Único fail-safe cuando el OCO no se pudo colocar.
export async function emergencyClose(client: EmergencyClient, a: EmergencyArgs): Promise<ExitResult> {
  const order = await client.createMarketSellOrder(a.symbol, a.qty);
  const fee = (order.fees && order.fees.length > 0)
    ? order.fees.reduce((s, f) => s + (f.cost ?? 0), 0)
    : (order.fee?.cost ?? 0);
  return { exitPrice: order.average ?? 0, exitFee: fee, exchangeOrderId: String(order.id) };
}
