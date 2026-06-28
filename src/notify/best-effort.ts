import { appendAuditLog } from '../db/repositories/audit-log.ts';

type Notify = (text: string) => Promise<{ messageId: string | null }>;

// La notificación es una capa separada best-effort (§principio rector): un fallo de notify NUNCA
// debe propagarse y tumbar el flujo tras mover dinero. Se audita y se sigue.
export async function notifyBestEffort(notify: Notify, text: string, actor: string): Promise<void> {
  try {
    await notify(text);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      await appendAuditLog({ eventType: 'notify_failed', actor, payload: { text, error } });
    } catch {
      process.stderr.write(`[${actor}] notify y audit fallaron: ${error}\n`);
    }
  }
}
