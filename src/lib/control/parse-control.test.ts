import { describe, test, expect, it } from 'vitest';
import { parseSlashCommand, normalizeSymbol } from './parse-control.ts';

describe('parseSlashCommand', () => {
  test('mapea los comandos slash conocidos', () => {
    expect(parseSlashCommand('/estado')).toEqual({ command: 'estado' });
    expect(parseSlashCommand('/pausa')).toEqual({ command: 'pausa' });
    expect(parseSlashCommand('/reanuda')).toEqual({ command: 'reanuda' });
  });
  test('normaliza mayúsculas, espacios y el slash opcional', () => {
    expect(parseSlashCommand('  /ESTADO ')).toEqual({ command: 'estado' });
    expect(parseSlashCommand('Pausa')).toEqual({ command: 'pausa' });
  });
  test('texto libre → null (lo resuelve el LLM)', () => {
    expect(parseSlashCommand('¿cómo va el bot?')).toBeNull();
  });
});

describe('parseSlashCommand cierra/modo', () => {
  it('/cierra BTC/USDT → cierra con symbol normalizado', () => {
    expect(parseSlashCommand('/cierra BTC/USDT')).toEqual({ command: 'cierra', symbol: 'BTC/USDT' });
  });
  it('/cierra btc → normaliza a BTC/USDT', () => {
    expect(parseSlashCommand('/cierra btc')).toEqual({ command: 'cierra', symbol: 'BTC/USDT' });
  });
  it('/cierra sin símbolo → cierra sin symbol (dispatch responde ayuda)', () => {
    expect(parseSlashCommand('/cierra')).toEqual({ command: 'cierra' });
  });
  it('/modo → modo', () => {
    expect(parseSlashCommand('/modo')).toEqual({ command: 'modo' });
  });
  it('texto libre sigue devolviendo null', () => {
    expect(parseSlashCommand('cómo va todo')).toBeNull();
  });
});

describe('normalizeSymbol', () => {
  it('añade /USDT si falta y pasa a mayúsculas', () => {
    expect(normalizeSymbol('btc')).toBe('BTC/USDT');
    expect(normalizeSymbol('eth/usdt')).toBe('ETH/USDT');
  });
});
