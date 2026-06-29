import type { ControlIntent } from './control-intent-schema.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';

export interface DispatchDeps {
  getOpenPositions: () => Promise<OpenPosition[]>;
  setPaused: (paused: boolean) => Promise<void>;
}

const AYUDA = 'Comandos: /estado · /pausa · /reanuda. (cerrar posiciones y cambiar de modo llegan en testnet)';

function renderEstado(positions: OpenPosition[]): string {
  if (positions.length === 0) return 'Estado: sin posiciones abiertas.';
  const lineas = positions.map((p) => `· ${p.symbol} @ ${p.entry} (size ${p.size}, sl ${p.sl ?? '—'} tp ${p.tp ?? '—'})`);
  return `Estado: ${positions.length} posición(es) abierta(s):\n${lineas.join('\n')}`;
}

// Ejecuta el comando (DETERMINISTA) y devuelve el texto de respuesta. SP11: solo comandos seguros
// (read + kill-switch). El LLM no llega aquí: solo clasificó la intención.
export async function dispatchControl(intent: ControlIntent, deps: DispatchDeps): Promise<string> {
  switch (intent.command) {
    case 'estado':
      return renderEstado(await deps.getOpenPositions());
    case 'pausa':
      await deps.setPaused(true);
      return '⏸️ Bot pausado: el scanner no disparará y los candidatos en cola no ejecutarán.';
    case 'reanuda':
      await deps.setPaused(false);
      return '▶️ Bot reanudado.';
    default:
      return AYUDA;
  }
}
