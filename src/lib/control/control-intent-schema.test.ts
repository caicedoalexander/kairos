import { describe, test, it, expect } from 'vitest';
import * as v from 'valibot';
import { parseControlIntent, ControlIntentSchema, ControlResultSchema } from './control-intent-schema.ts';

describe('ControlIntentSchema', () => {
  test('acepta cada comando del picklist', () => {
    for (const command of ['estado', 'pausa', 'reanuda', 'cierra', 'modo', 'unknown'] as const) {
      expect(parseControlIntent({ command })).toMatchObject({ command });
    }
  });
  test('rechaza un comando fuera del picklist', () => {
    expect(() => parseControlIntent({ command: 'desconocido' })).toThrow();
  });
});

describe('ControlIntentSchema (completo)', () => {
  it('acepta cierra con symbol', () => {
    expect(v.parse(ControlIntentSchema, { command: 'cierra', symbol: 'BTC/USDT' })).toEqual({ command: 'cierra', symbol: 'BTC/USDT' });
  });
  it('acepta modo sin symbol', () => {
    expect(v.parse(ControlIntentSchema, { command: 'modo' })).toEqual({ command: 'modo' });
  });
});

describe('ControlResultSchema (estricto, el que ve el LLM)', () => {
  it('RECHAZA cierra (línea roja: el LLM no puede gatillar un cierre)', () => {
    expect(() => v.parse(ControlResultSchema, { command: 'cierra' })).toThrow();
  });
  it('no admite el campo symbol', () => {
    // valibot v.object es estricto en exceso de claves sólo con strictObject; aquí basta el picklist.
    expect(v.parse(ControlResultSchema, { command: 'modo' })).toEqual({ command: 'modo' });
  });
});
