import type { SimParams } from './types.ts';

// Techo NO negociable de % de riesgo por trade (§19). El LLM nunca lo supera.
export const MAX_RISK_PER_TRADE = 2.0;

// Notional mínimo de una orden (evita órdenes polvo; análogo a minNotional de Binance).
export const MIN_NOTIONAL = 10;

// Modelo de fill paramétrico por defecto (fee 0.1% taker spot; spread/slippage conservadores).
export const DEFAULT_SIM_PARAMS: SimParams = { spread_bps: 4, slippage_bps: 5, fee_bps: 10 };

// Equity de arranque del sim si no hay snapshot previo.
export const DEFAULT_SIM_STARTING_EQUITY = 10000;
