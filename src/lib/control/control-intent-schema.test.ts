import { describe, test, expect } from 'vitest';
import { parseControlIntent } from './control-intent-schema.ts';

describe('ControlIntentSchema', () => {
  test('acepta cada comando del picklist', () => {
    for (const command of ['estado', 'pausa', 'reanuda', 'unknown'] as const) {
      expect(parseControlIntent({ command })).toEqual({ command });
    }
  });
  test('rechaza un comando fuera del picklist', () => {
    expect(() => parseControlIntent({ command: 'cierra' })).toThrow();
  });
});
