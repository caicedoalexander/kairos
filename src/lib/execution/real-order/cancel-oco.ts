import ccxt from 'ccxt';
import type { BracketLeg } from '../../../db/repositories/orders.ts';

export interface CancelOcoClient {
  cancelOrder(id: string, symbol: string): Promise<unknown>;
}

// Cancela el OCO residente cancelando UNA leg por su exchange_order_id. En Binance spot, cancelar una
// leg cancela toda la order-list (verificado ccxt 4.5.60). OrderNotFound (ya disparado/cancelado) = éxito.
// NetworkError se propaga: el caller aborta SIN tocar `protected` (la posición sigue protegida).
export async function cancelOco(client: CancelOcoClient, symbol: string, legs: BracketLeg[]): Promise<void> {
  const legId = legs.map((l) => l.exchangeOrderId).find((id): id is string => id !== null);
  if (!legId) return; // sin id de leg → nada que cancelar
  try {
    await client.cancelOrder(legId, symbol);
  } catch (err) {
    if (err instanceof ccxt.OrderNotFound) return;
    throw err;
  }
}
