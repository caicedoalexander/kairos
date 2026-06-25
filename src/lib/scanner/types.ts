import type { OhlcvRow } from '../market-data/types.ts';

export type Candle = OhlcvRow;
export type CandlesByTimeframe = Record<string, Candle[]>;

export type EmaStack = 'bullish' | 'bearish' | 'mixed';
export type MacdCross = 'up' | 'down' | 'none';
export type RsiState = 'oversold' | 'neutral' | 'overbought';
export type MtfAlignment = 'aligned' | 'mixed' | 'counter';

export interface Features {
  close: number;
  emaStack: EmaStack | null;
  macdCross: MacdCross | null;
  adx: number | null;
  rsi: number | null;
  rsiPrev: number | null;
  rsiState: RsiState | null;
  stochRsi: number | null;
  atrPct: number | null;
  bbPosition: number | null;
  aboveVwap: boolean | null;
  obv: number | null;
  mfi: number | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  distToSupportPct: number | null;
}

export interface DerivativesContext {
  fundingZ: number | null;
  oiChangePct: number | null;
}

export interface IndicatorSnapshot {
  byTimeframe: Record<string, Features>;
  mtfAlignment: MtfAlignment;
  levels: { support: number | null; resistance: number | null };
  derivatives: DerivativesContext;
}

export interface Signal {
  strategyId: string;
  symbol: string;
  firedAt: Date;
  snapshot: IndicatorSnapshot;
}

export interface Timeframes { bias: string; context: string; trigger: string; }

export type RuleNode =
  | { all: RuleNode[] }
  | { any: RuleNode[] }
  | { tf?: string; predicate: string; args?: Record<string, number> };

export interface TriggerConfig {
  timeframes: Timeframes;
  entry: RuleNode;
  skip?: RuleNode;
  allow_counter?: boolean;
}

export interface Strategy {
  id: string;
  enabled: boolean;
  symbols: string[];
  triggerConfig: TriggerConfig;
  riskParams: Record<string, unknown>;
  version: number;
  skillName?: string | null;
}
