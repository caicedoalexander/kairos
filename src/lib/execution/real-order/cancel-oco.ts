import ccxt from 'ccxt';
import type { BracketLeg } from '../../../db/repositories/orders.ts';

export interface CancelOcoClient {
  cancelOrder(id: string, symbol: string): Promise<unknown>;
}

// Cancela el OCO residente cancelando TODOS los exchangeOrderId distintos no-nulos (FIX H2). En Binance
// spot, cancelar una leg cancela toda su order-list; las legs viejas/canceladas dan OrderNotFound=éxito.
// Cancelar todos garantiza cancelar el OCO vivo aun si hay filas rancias (tras un reprotect de A.2).
// NetworkError se propaga: el caller aborta SIN tocar `protected` (la posición sigue protegida).
export async function cancelOco(client: CancelOcoClient, symbol: string, legs: BracketLeg[]): Promise<void> {
  const ids = [...new Set(legs.map((l) => l.exchangeOrderId).filter((id): id is string => id !== null))];
  for (const id of ids) {
    try { await client.cancelOrder(id, symbol); }
    catch (err) { if (!(err instanceof ccxt.OrderNotFound)) throw err; /* OrderNotFound = éxito */ }
  }
}
