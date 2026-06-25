// Tipos de fila del histórico de market-data (camelCase TS ↔ snake_case SQL). §8.
export interface OhlcvRow {
  symbol: string;
  timeframe: string;
  openTime: Date;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface FundingRow {
  symbol: string;
  ts: Date;
  rate: number;
}

export interface OpenInterestRow {
  symbol: string;
  ts: Date;
  oi: number;
  oiValue: number | null;
}
