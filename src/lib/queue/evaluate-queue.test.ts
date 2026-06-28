import { describe, test, expect } from 'vitest';
import { buildEvaluateJob, EVALUATE_QUEUE } from './evaluate-queue.ts';

describe('buildEvaluateJob', () => {
  test('usa jobId = signalId para deduplicar el encolado (idempotencia de cola)', () => {
    const spec = buildEvaluateJob('SIG123');
    expect(spec.data).toEqual({ signalId: 'SIG123' });
    expect(spec.opts.jobId).toBe('SIG123');
  });

  test('limpia jobs completados pero conserva los fallidos para inspección', () => {
    const spec = buildEvaluateJob('SIG123');
    expect(spec.opts.removeOnComplete).toBe(true);
    expect(spec.opts.removeOnFail).toBe(false);
  });

  test('el nombre de la cola es estable', () => {
    expect(EVALUATE_QUEUE).toBe('evaluate-candidate');
  });

  test('lanza si signalId está vacío (protección de frontera sin Redis)', () => {
    expect(() => buildEvaluateJob('')).toThrow('signalId requerido para encolar evaluate-candidate');
  });
});
