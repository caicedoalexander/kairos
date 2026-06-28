import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { TradingMode } from '../../lib/mode.ts';

export interface OrderRow {
  id: string;
  idempotency_key: string;
  status: string;
  size: string;
  mode: string;
}

export interface EntryOrderInput {
  idempotencyKey: string;
  decisionId: string;
  size: number;
  mode: TradingMode;
}

export interface BracketLegInput {
  idempotencyKey: string;
  decisionId: string;
  size: number;
  purpose: 'sl' | 'tp';
  parentId: string;
  mode: TradingMode;
}

// Claim idempotente: INSERT ON CONFLICT DO NOTHING. Devuelve {id} si lo insertó, null si ya existía.
export async function claimEntryOrder(
  o: EntryOrderInput,
  exec: Executor = query,
): Promise<{ id: string } | null> {
  const id = ulid();
  const rows = await exec<{ id: string }>(
    `INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, tif, purpose, status, mode)
     VALUES ($1, $2, $3, 'buy', $4, 'limit', 'IOC', 'entry', 'pending', $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [id, o.idempotencyKey, o.decisionId, o.size, o.mode],
  );
  return rows[0] ? { id: rows[0].id } : null;
}

function legType(purpose: 'sl' | 'tp'): string {
  return purpose === 'sl' ? 'stop_loss_limit' : 'take_profit_limit';
}

// Inserta un leg OCO (sl/tp) ligado a la entry order por parent_id.
export async function insertBracketLeg(
  leg: BracketLegInput,
  exec: Executor = query,
): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, tif, purpose, parent_id, status, mode)
     VALUES ($1, $2, $3, 'sell', $4, $5, NULL, $6, $7, 'pending', $8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [id, leg.idempotencyKey, leg.decisionId, leg.size, legType(leg.purpose), leg.purpose, leg.parentId, leg.mode],
  );
  return id;
}

export async function getOrderByIdempotencyKey(
  key: string,
  exec: Executor = query,
): Promise<OrderRow | null> {
  const rows = await exec<OrderRow>(
    `SELECT id, idempotency_key, status, size, mode FROM kairos.orders WHERE idempotency_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

export async function updateOrderStatus(
  id: string,
  status: string,
  exec: Executor = query,
): Promise<void> {
  await exec(`UPDATE kairos.orders SET status = $2 WHERE id = $1`, [id, status]);
}

// Cierra las legs OCO de una decisión al resolver el bracket: la tocada → filled, la otra → canceled.
export async function closeBracketLegs(
  decisionId: string, hitPurpose: 'sl' | 'tp', exec: Executor = query,
): Promise<void> {
  await exec(
    `UPDATE kairos.orders
        SET status = CASE WHEN purpose = $2 THEN 'filled' ELSE 'canceled' END
      WHERE decision_id = $1 AND purpose IN ('sl', 'tp')`,
    [decisionId, hitPurpose],
  );
}
