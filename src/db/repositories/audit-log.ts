import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface AuditLogEntry {
  eventType: string;
  actor: string;
  payload?: Record<string, unknown>;
}

// Append-first: el rastro de auditoría solo crece, nunca se actualiza ni borra.
export async function appendAuditLog(entry: AuditLogEntry, exec: Executor = query): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.audit_log (id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4)`,
    [id, entry.eventType, entry.actor, JSON.stringify(entry.payload ?? {})],
  );
  return id;
}
