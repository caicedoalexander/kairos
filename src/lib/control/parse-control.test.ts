import { describe, test, expect } from 'vitest';
import { parseSlashCommand } from './parse-control.ts';

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
    expect(parseSlashCommand('/cierra BTC')).toBeNull();
  });
});
