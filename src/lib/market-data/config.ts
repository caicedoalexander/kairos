// Configuración del banco de pruebas de market-data (Fase 1 / SP1). §15, §16.3.
export const SYMBOLS = ['BTC/USDT', 'ETH/USDT'] as const;
export const TIMEFRAMES = ['15m', '1h', '4h'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

// Profundidad de backfill de OHLCV/funding (~2 años).
export const BACKFILL_DAYS = 730;

// Velas/filas por request (límite de Binance vía ccxt).
export const FETCH_LIMIT = 1000;

// Granularidad del histórico de open interest (Binance retiene poco; §6 del spec).
export const OI_HISTORY_TIMEFRAME = '5m';

// El endpoint de OI histórico de Binance limita a 500 filas/request (máx. documentado).
export const OI_FETCH_LIMIT = 500;

const MINUTE_MS = 60_000;
const TIMEFRAME_MINUTES: Record<Timeframe, number> = { '15m': 15, '1h': 60, '4h': 240 };

// Duración de un timeframe en milisegundos.
export function timeframeToMs(timeframe: Timeframe): number {
  return TIMEFRAME_MINUTES[timeframe] * MINUTE_MS;
}

// Símbolo del perp USDM equivalente al spot. Asume cotización en USDT (cierto para SYMBOLS:
// 'BTC/USDT' → 'BTC/USDT:USDT'). §15.
export function toPerpSymbol(spotSymbol: string): string {
  return `${spotSymbol}:USDT`;
}
