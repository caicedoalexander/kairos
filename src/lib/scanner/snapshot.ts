// src/lib/scanner/snapshot.ts
import type { Features, Timeframes, DerivativesContext, MtfAlignment, IndicatorSnapshot } from './types.ts';

export function buildSnapshot(
  featuresByTf: Record<string, Features>, tfs: Timeframes, deriv: DerivativesContext, alignment: MtfAlignment,
): IndicatorSnapshot {
  const trigger = featuresByTf[tfs.trigger];
  return {
    byTimeframe: featuresByTf,
    mtfAlignment: alignment,
    levels: { support: trigger?.nearestSupport ?? null, resistance: trigger?.nearestResistance ?? null },
    derivatives: deriv,
  };
}
