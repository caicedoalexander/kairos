import { describe, test, expect, afterEach, vi } from 'vitest';

// Mocks de dependencias pesadas: evitan que rolldown intente parsear el skill .md de
// decision-maker y que se abran conexiones Redis/BullMQ durante la importación.
vi.mock('../workflows/decision-maker.ts', () => ({ default: {} }));
vi.mock('bullmq', () => ({ Worker: vi.fn() }));
vi.mock('../lib/queue/connection.ts', () => ({ getBullConnection: vi.fn() }));
vi.mock('../lib/queue/shadow-queue.ts', () => ({ SHADOW_QUEUE: 'shadow' }));
vi.mock('@flue/runtime', () => ({ invoke: vi.fn() }));
vi.mock('../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));

import { startShadowWorker } from './shadow-worker.ts';

describe('startShadowWorker', () => {
  const prev = process.env.SHADOW_WORKER;
  afterEach(() => {
    if (prev === undefined) delete process.env.SHADOW_WORKER;
    else process.env.SHADOW_WORKER = prev;
  });

  test('retorna null (sin abrir Redis) cuando SHADOW_WORKER no es "on"', () => {
    delete process.env.SHADOW_WORKER;
    expect(startShadowWorker()).toBeNull();
  });

  test('retorna null con cualquier valor distinto de "on"', () => {
    process.env.SHADOW_WORKER = 'off';
    expect(startShadowWorker()).toBeNull();
  });
});
