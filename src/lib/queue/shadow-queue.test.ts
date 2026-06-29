import { describe, test, expect } from 'vitest';
import { buildShadowJob } from './shadow-queue.ts';

describe('buildShadowJob', () => {
  test('jobId = signalId (dedup de encolado)', () => {
    const spec = buildShadowJob('sig-123');
    expect(spec.opts.jobId).toBe('sig-123');
    expect(spec.data.signalId).toBe('sig-123');
    expect(spec.name).toBe('shadow');
  });
  test('signalId vacío lanza', () => {
    expect(() => buildShadowJob('')).toThrow();
  });
});
