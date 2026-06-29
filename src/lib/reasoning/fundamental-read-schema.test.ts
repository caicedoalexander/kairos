import { describe, test, expect } from 'vitest';
import { parseFundamentalRead } from './fundamental-read-schema.ts';

const CON_CATALIZADOR = {
  bias: 'bearish',
  catalysts: [{ title: 'Exchange hackeado', sentiment: 'bearish', relevance: 'high' }],
  positioning: 'crowded_long',
  decayNote: 'Hace 20 min, aún caliente',
  confidence: 'alta',
};

const POSITIONING_ONLY = {
  bias: 'neutral',
  catalysts: [],
  positioning: 'crowded_short',
  confidence: 'media',
};

describe('FundamentalReadSchema', () => {
  test('acepta un read con catalizador y decayNote', () => {
    expect(parseFundamentalRead(CON_CATALIZADOR)).toEqual(CON_CATALIZADOR);
  });

  test('acepta el camino positioning-only (catalysts=[] y sin decayNote)', () => {
    expect(parseFundamentalRead(POSITIONING_ONLY)).toEqual(POSITIONING_ONLY);
  });

  test('rechaza positioning fuera del picklist', () => {
    expect(() => parseFundamentalRead({ ...POSITIONING_ONLY, positioning: 'moon' })).toThrow();
  });

  test('rechaza un catalyst con title vacío', () => {
    expect(() => parseFundamentalRead({ ...CON_CATALIZADOR, catalysts: [{ title: '', sentiment: 'bullish', relevance: 'low' }] })).toThrow();
  });

  test('rechaza decayNote vacío cuando está presente', () => {
    expect(() => parseFundamentalRead({ ...CON_CATALIZADOR, decayNote: '' })).toThrow();
  });
});
