import type { FundingRow, OpenInterestRow } from '../market-data/types.ts';
import type { DerivativesContext } from './types.ts';

// z-score del último funding vs su historia (§15.4). Serie corta → null; sin varianza → 0.
export function computeFundingZ(rates: FundingRow[]): number | null {
  if (rates.length < 2) return null;
  const xs = rates.map((r) => r.rate);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (xs[xs.length - 1] - mean) / sd;
}

// Cambio porcentual de OI del primer al último valor de la ventana (§15.4).
export function computeOiChangePct(ois: OpenInterestRow[]): number | null {
  if (ois.length < 2) return null;
  const first = ois[0].oi;
  const lastOi = ois[ois.length - 1].oi;
  if (first === 0) return null;
  return ((lastOi - first) / first) * 100;
}

export function computeDerivativesContext(rates: FundingRow[], ois: OpenInterestRow[]): DerivativesContext {
  return { fundingZ: computeFundingZ(rates), oiChangePct: computeOiChangePct(ois) };
}
