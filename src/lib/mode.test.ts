import { describe, test, expect, afterEach, vi } from 'vitest';
import { getMode } from './mode.ts';

afterEach(() => { vi.unstubAllEnvs(); });

describe('getMode', () => {
  test('devuelve sim cuando KAIROS_MODE no está definido', () => {
    vi.stubEnv('KAIROS_MODE', undefined);
    expect(getMode()).toBe('sim');
  });

  test('acepta sim|testnet|live', () => {
    for (const m of ['sim', 'testnet', 'live'] as const) {
      vi.stubEnv('KAIROS_MODE', m);
      expect(getMode()).toBe(m);
    }
  });

  test('lanza si KAIROS_MODE es inválido', () => {
    vi.stubEnv('KAIROS_MODE', 'production');
    expect(() => getMode()).toThrow('KAIROS_MODE inválido');
  });
});
