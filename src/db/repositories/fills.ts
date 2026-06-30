import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

// SP13: lee los fills de una orden (P&L y detección de fills ya registrados). Auxiliar, NO es el
// ancla de idempotencia (esa es la fila de posición; los fills son auditoría best-effort — FIX M2).
export async function getFillsForOrder(orderId: string, exec: Executor = query): Promise<{ price: number; qty: number; fee: number }[]> {
  const rows = await exec<{ price: string; qty: string; fee: string }>(
    `SELECT price, qty, fee FROM kairos.fills WHERE order_id = $1 ORDER BY ts`,
    [orderId],
  );
  return rows.map((r) => ({ price: Number(r.price), qty: Number(r.qty), fee: Number(r.fee) }));
}

export interface FillInput {
  orderId: string;
  price: number;
  qty: number;
  fee: number;
}

// Registra un llenado parcial o total de una orden (append-only).
// Nota de idempotencia: fills no tiene idempotency_key en el esquema (SP3).
// La no-duplicación está garantizada aguas arriba: execute_order corre en una transacción
// donde el claim de la entry order (ON CONFLICT DO NOTHING) es la frontera de idempotencia;
// si la entry ya existía, el flujo retorna 'duplicate' y nunca llega a insertFill.
export async function insertFill(f: FillInput, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.fills (id, order_id, price, qty, fee) VALUES ($1, $2, $3, $4, $5)`,
    [id, f.orderId, f.price, f.qty, f.fee],
  );
  return id;
}
