// src/lib/execution/real-order/place-oco.ts
import ccxt from 'ccxt';
import { stopLimitPrice } from './precision.ts';
import { STOP_LIMIT_OFFSET_BPS, MAX_OCO_RETRIES, OCO_RETRY_BACKOFF_MS } from '../limits.ts';

export interface OcoClient {
  market(symbol: string): { id: string };
  amountToPrecision(symbol: string, amount: number): string;
  priceToPrecision(symbol: string, price: number): string;
  // El endpoint crudo de ccxt devuelve unknown; casteamos a OcoRaw internamente.
  privatePostOrderListOco(params: Record<string, string>): Promise<unknown>;
}
interface OcoRaw { orderListId: number; orderReports: Array<{ orderId: number; type: string }> }

export interface PlaceOcoArgs { symbol: string; qty: number; sl: number; tp: number }
export interface OcoResult { orderListId: string; slOrderId: string; tpOrderId: string }

// OCO de venta (protege un long): TP = LIMIT_MAKER above; SL = STOP_LOSS_LIMIT below (trigger + límite).
export async function placeOco(client: OcoClient, a: PlaceOcoArgs): Promise<OcoResult> {
  const params: Record<string, string> = {
    symbol: client.market(a.symbol).id,
    side: 'SELL',
    quantity: client.amountToPrecision(a.symbol, a.qty),
    aboveType: 'LIMIT_MAKER',
    abovePrice: client.priceToPrecision(a.symbol, a.tp),
    belowType: 'STOP_LOSS_LIMIT',
    belowStopPrice: client.priceToPrecision(a.symbol, a.sl),
    belowPrice: client.priceToPrecision(a.symbol, stopLimitPrice(a.sl, STOP_LIMIT_OFFSET_BPS)),
    belowTimeInForce: 'GTC',
  };
  const raw = await retryOnNetwork(() => client.privatePostOrderListOco(params), MAX_OCO_RETRIES) as OcoRaw;
  if (!Array.isArray(raw.orderReports)) throw new Error('OCO respuesta inesperada: orderReports no es un array');
  const sl = raw.orderReports.find((o) => o.type === 'STOP_LOSS_LIMIT');
  const tp = raw.orderReports.find((o) => o.type === 'LIMIT_MAKER');
  if (!sl || !tp) throw new Error('OCO sin legs SL/TP en orderReports');
  return { orderListId: String(raw.orderListId), slOrderId: String(sl.orderId), tpOrderId: String(tp.orderId) };
}

// Reintenta sólo errores de red (NetworkError ⊃ RequestTimeout/RateLimit/ExchangeNotAvailable),
// con backoff exponencial (M2: RateLimitExceeded sin espera empeora; el backoff lo alivia).
async function retryOnNetwork<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (!(err instanceof ccxt.NetworkError)) throw err;  // ExchangeError → no reintenta
      lastErr = err;
      if (i < attempts - 1) await sleep(OCO_RETRY_BACKOFF_MS * 2 ** i);
    }
  }
  throw lastErr;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
