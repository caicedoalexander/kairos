import type { Candle } from './types.ts';

// Swings por pivotes: i es swing high si su high es el máximo de la ventana [i-lb, i+lb]
// (análogo para swing low). Los últimos `lookback` no se confirman (no hay ventana derecha).
export function computeStructure(candles: Candle[], lookback = 5): { supports: number[]; resistances: number[] } {
  const supports: number[] = [];
  const resistances: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const maxHigh = Math.max(...window.map((w) => w.h));
    const minLow = Math.min(...window.map((w) => w.l));
    if (candles[i].h === maxHigh) resistances.push(candles[i].h);
    if (candles[i].l === minLow) supports.push(candles[i].l);
  }
  return { supports, resistances };
}

// Mayor nivel ≤ price (soporte por debajo), o null.
export function nearestBelow(price: number, levels: number[]): number | null {
  const below = levels.filter((l) => l <= price);
  return below.length > 0 ? Math.max(...below) : null;
}

// Menor nivel ≥ price (resistencia por encima), o null.
export function nearestAbove(price: number, levels: number[]): number | null {
  const above = levels.filter((l) => l >= price);
  return above.length > 0 ? Math.min(...above) : null;
}
