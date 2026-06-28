import { describe, test, expect } from 'vitest';
import * as v from 'valibot';
import { LlmVerdictSchema, parseLlmVerdict } from './verdict-schema.ts';

describe('LlmVerdictSchema', () => {
  test('acepta un veredicto válido', () => {
    const ok = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.5, confianza: 'media', razonamiento: 'confluencia alcista' };
    expect(parseLlmVerdict(ok)).toEqual(ok);
  });

  test('rechaza sizingFactor fuera de [0,1] y confianza inválida', () => {
    expect(() => parseLlmVerdict({ action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1.5, confianza: 'media', razonamiento: 'x' })).toThrow();
    expect(() => v.parse(LlmVerdictSchema, { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.5, confianza: 'altísima', razonamiento: 'x' })).toThrow();
    expect(() => parseLlmVerdict({ action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: -0.1, confianza: 'media', razonamiento: 'x' })).toThrow();
    expect(() => parseLlmVerdict({ action: 'hold', entry: 100, sl: 97, tp: 106, sizingFactor: 0.5, confianza: 'media', razonamiento: 'x' })).toThrow();
  });
});
