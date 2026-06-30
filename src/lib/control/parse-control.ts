import type { ControlIntent } from './control-intent-schema.ts';

const SLASH: Record<string, ControlIntent['command']> = {
  estado: 'estado', pausa: 'pausa', reanuda: 'reanuda', cierra: 'cierra', modo: 'modo',
};

// Normaliza un símbolo del operador: mayúsculas; si no trae par de cotización, asume /USDT.
export function normalizeSymbol(raw: string): string {
  const up = raw.trim().toUpperCase();
  return up.includes('/') ? up : `${up}/USDT`;
}

// Parser determinista de comandos slash. Devuelve null para texto libre (lo interpreta el LLM).
// Para /cierra captura el símbolo (segunda palabra, normalizado); sin segunda palabra → sin symbol.
export function parseSlashCommand(text: string): ControlIntent | null {
  const parts = text.trim().split(/\s+/);
  const first = (parts[0] ?? '').toLowerCase();
  const word = first.startsWith('/') ? first.slice(1) : first;
  const command = SLASH[word];
  if (!command) return null;
  if (command === 'cierra') {
    const arg = parts[1];
    return arg ? { command, symbol: normalizeSymbol(arg) } : { command };
  }
  return { command };
}
