import { describe, test, expect } from 'vitest';
import { buildShadowJob, SHADOW_QUEUE } from './shadow-queue.ts';

describe('buildShadowJob', () => {
  test('jobId = signalId (dedup de encolado)', () => {
    const spec = buildShadowJob('sig-123');
    expect(spec.opts.jobId).toBe('sig-123');
    expect(spec.data.signalId).toBe('sig-123');
    expect(spec.name).toBe('shadow');
  });
  test('limpia jobs completados pero conserva los fallidos para inspección', () => {
    const spec = buildShadowJob('sig-123');
    expect(spec.opts.removeOnComplete).toBe(true);
    expect(spec.opts.removeOnFail).toBe(false);
  });
  test('signalId vacío lanza', () => {
    expect(() => buildShadowJob('')).toThrow();
  });
});

test('SHADOW_QUEUE es el nombre estable de la cola', () => {
  expect(SHADOW_QUEUE).toBe('shadow-eval');
});
