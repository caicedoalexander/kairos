import { describe, test, expect } from 'vitest';
import { shouldEscalate } from './escalation.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';

const V = (confianza: 'alta' | 'media' | 'baja'): LlmVerdict => ({ action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 0.5, confianza, razonamiento: 'x' });
const tech = (bias: 'bullish' | 'neutral' | 'bearish'): TechnicalRead => ({ bias, confluence: 'moderate', regime: 'trending', divergence: 'none', mtfNote: 'm', notes: 'n' });
const fund = (bias: 'bullish' | 'neutral' | 'bearish'): FundamentalRead => ({ bias, catalysts: [], positioning: 'neutral', confidence: 'media' });

describe('shouldEscalate', () => {
  test('confianza baja → escala', () => {
    expect(shouldEscalate(V('baja'), tech('bullish'), fund('bullish'))).toBe(true);
  });
  test('analistas opuestos (técnico bullish, fundamental bearish) → escala', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), fund('bearish'))).toBe(true);
  });
  test('analistas opuestos al revés (técnico bearish, fundamental bullish) → escala', () => {
    expect(shouldEscalate(V('media'), tech('bearish'), fund('bullish'))).toBe(true);
  });
  test('confianza alta y analistas alineados → no escala', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), fund('bullish'))).toBe(false);
  });
  test('un read neutral no cuenta como contradicción', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), fund('neutral'))).toBe(false);
  });
  test('sin fundamental (null) y confianza alta → no escala', () => {
    expect(shouldEscalate(V('alta'), tech('bullish'), null)).toBe(false);
  });
});
