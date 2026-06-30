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
  exchangeOrderId?: string;   // SP12: id del leg en el exchange (testnet/live); null en sim
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
    `INSERT INTO kairos.orders (id, idempotency_key, decision_id, side, size, type, tif, purpose, parent_id, status, mode, exchange_order_id)
     VALUES ($1, $2, $3, 'sell', $4, $5, NULL, $6, $7, 'pending', $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [id, leg.idempotencyKey, leg.decisionId, leg.size, legType(leg.purpose), leg.purpose, leg.parentId, leg.mode, leg.exchangeOrderId ?? null],
  );
  return id;
}

// SP12: guarda el id de la orden en el exchange tras un fill real.
export async function setOrderExchangeId(id: string, exchangeOrderId: string, exec: Executor = query): Promise<void> {
  await exec(`UPDATE kairos.orders SET exchange_order_id = $2 WHERE id = $1`, [id, exchangeOrderId]);
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

export interface StuckOrderRow { id: string; idempotency_key: string; purpose: string; }

// Órdenes de entrada 'pending' sin fill, aisladas por modo. En sim la entry se llena en la misma
// transacción → en arranque limpio esto es ~vacío; el valor real es en testnet/live (claim y fill
// separados), donde habría que añadir además `AND o.created_at < now() - interval '5 minutes'`.
export async function findStuckEntryOrders(mode: TradingMode, exec: Executor = query): Promise<StuckOrderRow[]> {
  return exec<StuckOrderRow>(
    `SELECT o.id, o.idempotency_key, o.purpose
       FROM kairos.orders o
       LEFT JOIN kairos.fills f ON f.order_id = o.id
      WHERE o.purpose = 'entry' AND o.status = 'pending' AND f.id IS NULL AND o.mode = $1`,
    [mode],
  );
}

// Legs OCO 'pending' cuya posición ya está cerrada: huérfanas (deberían quedar filled/canceled al
// salir). Aisladas por modo. Nota: posiciones SP5 con decision_id NULL no se detectan (el JOIN no
// iguala NULL); son inocuas en sim y se aceptan en la transición.
export async function findOrphanedClosedLegs(mode: TradingMode, exec: Executor = query): Promise<StuckOrderRow[]> {
  return exec<StuckOrderRow>(
    `SELECT o.id, o.idempotency_key, o.purpose
       FROM kairos.orders o
       JOIN kairos.positions p ON p.decision_id = o.decision_id
      WHERE o.purpose IN ('sl', 'tp') AND o.status = 'pending' AND p.status = 'closed' AND p.mode = $1`,
    [mode],
  );
}

export interface UnresolvedEntry { id: string; idempotencyKey: string; decisionId: string; symbol: string; strategyId: string }

// Entradas inciertas a reconciliar (A.1). Con FILTRO DE FRESCURA (FIX H1): excluye in-flight cuya
// ventana de lock (SETUP_LOCK_TTL_MS) aún no expiró, para no pisar al executor. Sin posición para su decisión.
export async function findUnresolvedEntries(mode: TradingMode, exec: Executor = query): Promise<UnresolvedEntry[]> {
  const rows = await exec<{ id: string; idempotency_key: string; decision_id: string; symbol: string; strategy_id: string }>(
    `SELECT o.id, o.idempotency_key, o.decision_id, s.symbol, s.strategy_id
       FROM kairos.orders o
       JOIN kairos.decisions d ON d.id = o.decision_id
       JOIN kairos.signals s ON s.id = d.signal_id
      WHERE o.purpose = 'entry' AND o.status IN ('pending', 'pending_execution') AND o.mode = $1
        AND o.created_at < now() - interval '5 minutes'
        AND NOT EXISTS (SELECT 1 FROM kairos.positions p WHERE p.decision_id = o.decision_id)`,
    [mode],
  );
  return rows.map((r) => ({ id: r.id, idempotencyKey: r.idempotency_key, decisionId: r.decision_id, symbol: r.symbol, strategyId: r.strategy_id }));
}

// Gate de dedup (Componente D): ¿hay una entrada sin resolver para el setup? SIN filtro de frescura
// (una pending_execution recién creada debe bloquear B de inmediato — FIX H1).
export async function hasUnresolvedEntryForSetup(strategyId: string, symbol: string, mode: TradingMode, exec: Executor = query): Promise<boolean> {
  const rows = await exec(
    `SELECT 1 FROM kairos.orders o
       JOIN kairos.decisions d ON d.id = o.decision_id
       JOIN kairos.signals s ON s.id = d.signal_id
      WHERE o.purpose = 'entry' AND o.status IN ('pending', 'pending_execution') AND o.mode = $3
        AND s.strategy_id = $1 AND s.symbol = $2 LIMIT 1`,
    [strategyId, symbol, mode],
  );
  return rows.length > 0;
}

export interface BracketLeg { id: string; purpose: 'sl' | 'tp'; exchangeOrderId: string | null; status: string }

// Legs OCO de una decisión (monitor real + reconciler A.2): id en el exchange + estado.
export async function getBracketLegs(decisionId: string, exec: Executor = query): Promise<BracketLeg[]> {
  const rows = await exec<{ id: string; purpose: string; exchange_order_id: string | null; status: string }>(
    `SELECT id, purpose, exchange_order_id, status FROM kairos.orders
      WHERE decision_id = $1 AND purpose IN ('sl', 'tp')`,
    [decisionId],
  );
  return rows.map((r) => ({ id: r.id, purpose: r.purpose as 'sl' | 'tp', exchangeOrderId: r.exchange_order_id, status: r.status }));
}
