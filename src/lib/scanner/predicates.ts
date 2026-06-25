import type { Features, DerivativesContext } from './types.ts';

export interface PredicateCtx { deriv: DerivativesContext; }
export type PredicateFn = (f: Features, args: Record<string, number>, ctx: PredicateCtx) => boolean;

// Predicados puros sobre features. Un feature null → false (predicado no satisfecho), nunca lanza.
export const predicates: Record<string, PredicateFn> = {
  ema_stack_bullish: (f) => f.emaStack === 'bullish',
  ema_stack_bearish: (f) => f.emaStack === 'bearish',
  above_vwap: (f) => f.aboveVwap === true,
  below_vwap: (f) => f.aboveVwap === false,
  rsi_cross_up: (f, a) => f.rsi !== null && f.rsiPrev !== null && f.rsiPrev < a.level && f.rsi >= a.level,
  rsi_oversold: (f) => f.rsiState === 'oversold',
  rsi_overbought: (f) => f.rsiState === 'overbought',
  macd_cross_up: (f) => f.macdCross === 'up',
  macd_cross_down: (f) => f.macdCross === 'down',
  near_support: (f, a) => f.distToSupportPct !== null && f.distToSupportPct <= a.max_dist_pct,
  atr_pct_above: (f, a) => f.atrPct !== null && f.atrPct > a.max,
  adx_above: (f, a) => f.adx !== null && f.adx > a.min,
  funding_z_extreme: (_f, a, ctx) => ctx.deriv.fundingZ !== null && Math.abs(ctx.deriv.fundingZ) > a.max_abs,
};
