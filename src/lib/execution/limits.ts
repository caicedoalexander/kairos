import type { SimParams } from './types.ts';

// Techo NO negociable de % de riesgo por trade (§19). El LLM nunca lo supera.
export const MAX_RISK_PER_TRADE = 2.0;

// Notional mínimo de una orden (evita órdenes polvo; análogo a minNotional de Binance).
export const MIN_NOTIONAL = 10;

// Modelo de fill paramétrico por defecto (fee 0.1% taker spot; spread/slippage conservadores).
export const DEFAULT_SIM_PARAMS: SimParams = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 };

// Equity de arranque del sim si no hay snapshot previo.
export const DEFAULT_SIM_STARTING_EQUITY = 10000;

// Lock por setup (SP12): TTL que acota el peor caso entrada + OCO(retries) + cierre de emergencia.
export const SETUP_LOCK_TTL_MS = 45_000;

// OCO residente (SP12): offset del límite del stop bajo el trigger; reintentos + backoff del OCO ante blip de red.
export const STOP_LIMIT_OFFSET_BPS = 20;
export const MAX_OCO_RETRIES = 3;
export const OCO_RETRY_BACKOFF_MS = 300;   // base del backoff exponencial (300, 600, …)

// Reconciler ccxt (SP13): cadencia del tick periódico de auto-sanación (arranque corre aparte).
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

// Frescura OHLCV (SP13): cadencia del refresh; debe ser ≤ MONITOR_INTERVAL_MS (el worker la valida).
export const OHLCV_REFRESH_INTERVAL_MS = 60_000;
