import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';

// Escalación = decisión DETERMINISTA (el código, no el modelo), §296. En sombra solo las condiciones
// que el camino sombra cablea: confianza baja de Sonnet O analistas estrictamente opuestos.
// Diferidos (testnet/live): notional > X% equity, primera-op-live (ShadowEvalArgs no cablea equity).
export function shouldEscalate(
  verdict: LlmVerdict, technicalRead: TechnicalRead | null, fundamentalRead: FundamentalRead | null,
): boolean {
  if (verdict.confianza === 'baja') return true;
  if (technicalRead && fundamentalRead) {
    const t = technicalRead.bias, f = fundamentalRead.bias;
    const opposed = (t === 'bullish' && f === 'bearish') || (t === 'bearish' && f === 'bullish');
    if (opposed) return true;
  }
  return false;
}
