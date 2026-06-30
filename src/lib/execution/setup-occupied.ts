import { hasOpenPositionForSetup } from '../../db/repositories/positions.ts';
import { hasUnresolvedEntryForSetup } from '../../db/repositories/orders.ts';
import type { TradingMode } from '../mode.ts';

// Gate de dedup setup-aware (SP13, Componente D): un setup está ocupado si tiene una posición abierta
// O una entrada sin resolver (pending/pending_execution). Esto cierra la doble-compra I1 POR SEGURIDAD,
// independiente de la cadencia del reconciler. Corta-circuito: la posición abierta es el caso común.
export async function isSetupOccupied(strategyId: string, symbol: string, mode: TradingMode): Promise<boolean> {
  if (await hasOpenPositionForSetup(strategyId, symbol, mode)) return true;
  return hasUnresolvedEntryForSetup(strategyId, symbol, mode);
}
