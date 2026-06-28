import { describe, test, expect, vi } from 'vitest';
import { notifyBestEffort } from './best-effort.ts';

vi.mock('../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn(async () => 'id') }));
import { appendAuditLog } from '../db/repositories/audit-log.ts';

describe('notifyBestEffort', () => {
  test('éxito: llama notify, no audita', async () => {
    const notify = vi.fn(async () => ({ messageId: 'm1' }));
    await notifyBestEffort(notify, 'hola', 'monitor');
    expect(notify).toHaveBeenCalledOnce();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  test('fallo de notify: audita notify_failed con el actor, no lanza', async () => {
    const notify = vi.fn(async () => { throw new Error('Evolution caído'); });
    await expect(notifyBestEffort(notify, 'hola', 'monitor')).resolves.toBeUndefined();
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'notify_failed', actor: 'monitor' }));
  });
});
