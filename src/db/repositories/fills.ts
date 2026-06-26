import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

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
