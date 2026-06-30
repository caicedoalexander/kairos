import type { TrailingConfig } from './trailing-config.ts';

// Regla pura del trailing. `price` = precio VIVO (fetchTicker, FIX H1). Devuelve el SL nuevo si procede
// subirlo, o null. El SL SOLO sube (ratchet): pasar el último gate con min_step_pct ≥ 0 y currentSl > 0
// implica candidate > currentSl. Línea roja: el SL nunca baja.
export function computeTrailingSl(args: { entry: number; currentSl: number; price: number; cfg: TrailingConfig }): number | null {
  const { entry, currentSl, price, cfg } = args;
  if (price <= entry * (1 + cfg.activation_pct)) return null;       // aún no activa (no en ganancia umbral)
  const candidate = price * (1 - cfg.distance_pct);                 // SL candidato bajo el precio vivo
  if (candidate >= price) return null;                             // sanity (con cfg válido no ocurre)
  if (candidate <= currentSl * (1 + cfg.min_step_pct)) return null; // no supera el SL vigente por min_step → nunca baja + anti-churn
  return candidate;
}
