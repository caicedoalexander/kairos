import ccxt from 'ccxt';

interface RawOrderState { id?: string; status?: string; filled?: number; average?: number }
interface RawTrade { price?: number; amount?: number; fee?: { cost?: number; currency?: string }; fees?: Array<{ cost?: number; currency?: string }> }

export interface OrderStateClient {
  fetchOrder(id: string | undefined, symbol: string, params?: Record<string, unknown>): Promise<RawOrderState>;
  fetchOrderTrades(id: string, symbol: string): Promise<RawTrade[]>;
}

// FIX M-2: `exchangeOrderId` lleva el id real que asigna Binance (para persistir en orders.exchange_order_id),
// NO el clientOrderId con el que se consultó.
export type EntryState = { found: false } | { found: true; status: string; filled: number; average: number; exchangeOrderId: string };

// Recupera el estado de una entrada por clientOrderId (origClientOrderId en binance). OrderNotFound
// significa que la entrada nunca llegó al exchange → found:false. NetworkError se propaga (retry del caller).
export async function fetchEntryState(client: OrderStateClient, symbol: string, clientOrderId: string): Promise<EntryState> {
  try {
    const o = await client.fetchOrder(undefined, symbol, { clientOrderId });
    return { found: true, status: o.status ?? 'unknown', filled: o.filled ?? 0, average: o.average ?? 0, exchangeOrderId: String(o.id ?? '') };
  } catch (err) {
    if (err instanceof ccxt.OrderNotFound) return { found: false };
    throw err;
  }
}

export async function fetchLegState(client: OrderStateClient, symbol: string, legId: string): Promise<{ status: string; filled: number }> {
  const o = await client.fetchOrder(legId, symbol);
  return { status: o.status ?? 'unknown', filled: o.filled ?? 0 };
}

export interface ExitFromTrades { exitPrice: number; exitFee: number; qty: number }

// Reconstruye el exit real desde los trades de una orden de salida (leg OCO o market de emergencia):
// precio = vwap, fee = suma de comisiones, qty = suma de amounts.
export async function fetchExitFromTrades(client: OrderStateClient, symbol: string, orderId: string): Promise<ExitFromTrades> {
  const trades = await client.fetchOrderTrades(orderId, symbol);
  let qty = 0, gross = 0, fee = 0;
  for (const t of trades) {
    const a = t.amount ?? 0;
    qty += a;
    gross += (t.price ?? 0) * a;
    fee += sumTradeFee(t);
  }
  return { exitPrice: qty > 0 ? gross / qty : 0, exitFee: fee, qty };
}

function sumTradeFee(t: RawTrade): number {
  if (t.fees && t.fees.length > 0) return t.fees.reduce((s, f) => s + (f.cost ?? 0), 0);
  return t.fee?.cost ?? 0;
}
