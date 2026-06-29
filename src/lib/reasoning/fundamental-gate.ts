import type { IndicatorSnapshot } from '../scanner/types.ts';
import type { NewsItem } from '../sources/news.ts';

const MAJOR_CAPS = new Set(['BTC', 'ETH']);   // §17.2: solo major-caps (Set nombrado, fácil de extender)
const FUNDING_Z_EXTREME = 2.0;                 // |z| de funding que activa cautela fundamental
const OI_CHANGE_EXTREME_PCT = 10;              // |%| de cambio de OI que activa cautela

// base de 'BTC/USDT' → 'BTC'.
export function isMajorCap(symbol: string): boolean {
  return MAJOR_CAPS.has(symbol.split('/')[0]);
}

// El cliente de noticias (RSS) ya filtra a la ventana, así que news.length>0 ⇒ catalizador en ventana.
// Corre el fundamental si hay catalizador O posicionamiento extremo (funding/OI del snapshot).
export function shouldRunFundamental(news: NewsItem[], snapshot: IndicatorSnapshot): boolean {
  const hasCatalyst = news.length > 0;
  const d = snapshot.derivatives;
  const extreme =
    (d.fundingZ != null && Math.abs(d.fundingZ) >= FUNDING_Z_EXTREME) ||
    (d.oiChangePct != null && Math.abs(d.oiChangePct) >= OI_CHANGE_EXTREME_PCT);
  return hasCatalyst || extreme;
}
