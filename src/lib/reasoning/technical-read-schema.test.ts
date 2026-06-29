// src/lib/reasoning/technical-read-schema.test.ts
import { describe, test, expect } from 'vitest';
import { parseTechnicalRead, TechnicalReadSchema } from './technical-read-schema.ts';
import * as v from 'valibot';

const VALID = {
  bias: 'bullish', confluence: 'strong', regime: 'trending',
  divergence: 'none', mtfNote: '4h alcista alinea con 15m', notes: 'EMA stack alcista y RSI sano',
};

describe('TechnicalReadSchema', () => {
  test('acepta un read válido', () => {
    expect(parseTechnicalRead(VALID)).toEqual(VALID);
  });

  test('rechaza bias fuera del picklist', () => {
    expect(() => parseTechnicalRead({ ...VALID, bias: 'moon' })).toThrow();
  });

  test('rechaza mtfNote vacío (minLength 1)', () => {
    expect(() => parseTechnicalRead({ ...VALID, mtfNote: '' })).toThrow();
  });

  test('rechaza notes ausente', () => {
    const { notes, ...sinNotes } = VALID;
    expect(() => parseTechnicalRead(sinNotes)).toThrow();
  });

  test('el schema infiere los 6 campos', () => {
    expect(Object.keys(TechnicalReadSchema.entries).sort()).toEqual(
      ['bias', 'confluence', 'divergence', 'mtfNote', 'notes', 'regime'],
    );
  });
});
