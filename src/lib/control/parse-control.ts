import type { ControlIntent } from './control-intent-schema.ts';

const SLASH: Record<string, ControlIntent['command']> = {
  estado: 'estado', pausa: 'pausa', reanuda: 'reanuda',
};

// Parser determinista de comandos slash conocidos. Devuelve null para todo lo demás (texto libre que
// el LLM debe interpretar). Acepta con/sin '/', mayúsculas y espacios; solo la primera palabra.
export function parseSlashCommand(text: string): ControlIntent | null {
  const first = text.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const word = first.startsWith('/') ? first.slice(1) : first;
  const command = SLASH[word];
  return command ? { command } : null;
}
