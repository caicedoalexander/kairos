import type { Features, Timeframes, MtfAlignment, TriggerConfig } from './types.ts';

// Gate top-down (§16.4): el sesgo HTF gobierna. Spot = setups long.
export function computeMtfAlignment(featuresByTf: Record<string, Features>, tfs: Timeframes): MtfAlignment {
  const bias = featuresByTf[tfs.bias]?.emaStack ?? null;
  const context = featuresByTf[tfs.context]?.emaStack ?? null;
  if (bias === 'bearish') return 'counter';
  if (bias === 'bullish' && context !== 'bearish') return 'aligned';
  return 'mixed';
}

// counter se filtra salvo allow_counter explícito en el config.
export function passesMtfGate(alignment: MtfAlignment, config: TriggerConfig): boolean {
  if (alignment === 'counter') return config.allow_counter === true;
  return true;
}
