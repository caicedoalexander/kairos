export type TradingMode = 'sim' | 'testnet' | 'live';

const VALID_MODES: readonly TradingMode[] = ['sim', 'testnet', 'live'];

// Modo de ejecución explícito y persistido en config; 'sim' es el default seguro (§10).
export function getMode(): TradingMode {
  const value = process.env.KAIROS_MODE ?? 'sim';
  if (!VALID_MODES.includes(value as TradingMode)) {
    throw new Error(`KAIROS_MODE inválido: "${value}" (esperado sim|testnet|live)`);
  }
  return value as TradingMode;
}
