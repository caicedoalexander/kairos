import type { ControlIntent } from './control-intent-schema.ts';
import type { OpenPosition } from '../../db/repositories/positions.ts';
import type { TradingMode } from '../mode.ts';

export interface DispatchDeps {
  getOpenPositions: () => Promise<OpenPosition[]>;
  setPaused: (paused: boolean) => Promise<void>;
  closePosition: (symbol: string) => Promise<string>;
  currentMode: TradingMode;
}

const AYUDA = 'Comandos: /estado · /pausa · /reanuda · /cierra <símbolo> · /modo.';

function renderEstado(positions: OpenPosition[]): string {
  if (positions.length === 0) return 'Estado: sin posiciones abiertas.';
  const lineas = positions.map((p) => `· ${p.symbol} @ ${p.entry} (size ${p.size}, sl ${p.sl ?? '—'} tp ${p.tp ?? '—'})`);
  return `Estado: ${positions.length} posición(es) abierta(s):\n${lineas.join('\n')}`;
}

// Ejecuta el comando (DETERMINISTA) y devuelve el texto de respuesta. El LLM no llega aquí: solo
// clasificó la intención (y nunca a 'cierra' — ése solo lo produce el slash).
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
    case 'cierra':
      if (!intent.symbol) return `Uso: /cierra <símbolo>. Ej: /cierra BTC/USDT.`;
      return deps.closePosition(intent.symbol);
    case 'modo':
      return `Modo actual: ${deps.currentMode}. (conmutar requiere reiniciar con KAIROS_MODE=…; la conmutación en caliente llega en un sprint propio).`;
    default:
      return AYUDA;
  }
}
