import { withTransaction } from '../../db/pool.ts';
import { closeOpenPosition, type OpenPosition } from '../../db/repositories/positions.ts';
import { closeBracketLegs } from '../../db/repositories/orders.ts';
import { appendAuditLog } from '../../db/repositories/audit-log.ts';
import type { BracketResolution } from '../execution/types.ts';

// Cierre determinista por bracket en una transacción: cierra la posición (idempotente), cierra las
// legs OCO de su decisión y audita. Devuelve false si otra corrida del tick ya la cerró.
export async function closePositionOnBracket(
  position: OpenPosition, resolution: BracketResolution, closedAt: Date,
): Promise<boolean> {
  return withTransaction(async (exec) => {
    const closed = await closeOpenPosition(position.id, resolution.realizedPnl, closedAt, exec);
    if (!closed) return false;
    if (position.decisionId) await closeBracketLegs(position.decisionId, resolution.hitType, exec);
    await appendAuditLog({
      eventType: 'position_closed_sim', actor: 'monitor',
      payload: { positionId: position.id, symbol: position.symbol, hitType: resolution.hitType,
        exitPrice: resolution.exitPrice, realizedPnl: resolution.realizedPnl },
    }, exec);
    return true;
  });
}
