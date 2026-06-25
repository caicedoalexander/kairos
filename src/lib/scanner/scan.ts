// src/lib/scanner/scan.ts
import type { Strategy, CandlesByTimeframe, DerivativesContext, Signal, Features } from './types.ts';
import { computeFeatures } from './features.ts';
import { evaluateEntry, evaluateSkip } from './rules-engine.ts';
import { computeMtfAlignment, passesMtfGate } from './mtf.ts';
import { buildSnapshot } from './snapshot.ts';

// Velas mínimas por TF para que los indicadores (EMA200) sean válidos (§ política de warmup).
export const REQUIRED_WARMUP = 200;

// Núcleo PURO: velas inyectadas → Signal | null. Sin acceso a DB (reusable por SP4/SP5).
export function scan(
  strategy: Strategy, symbol: string, candlesByTf: CandlesByTimeframe, deriv: DerivativesContext, now: Date,
): Signal | null {
  const tfs = strategy.triggerConfig.timeframes;
  const tfList = [tfs.bias, tfs.context, tfs.trigger];

  // Gate de warmup: datos insuficientes en alguna TF → no dispara.
  for (const tf of tfList) {
    if ((candlesByTf[tf]?.length ?? 0) < REQUIRED_WARMUP) return null;
  }

  const featuresByTf: Record<string, Features> = {};
  for (const tf of tfList) featuresByTf[tf] = computeFeatures(candlesByTf[tf]);

  const alignment = computeMtfAlignment(featuresByTf, tfs);
  if (!passesMtfGate(alignment, strategy.triggerConfig)) return null;

  const ctx = { deriv };
  if (evaluateSkip(strategy.triggerConfig, featuresByTf, tfs.trigger, ctx)) return null;
  if (!evaluateEntry(strategy.triggerConfig, featuresByTf, tfs.trigger, ctx)) return null;

  return { strategyId: strategy.id, symbol, firedAt: now, snapshot: buildSnapshot(featuresByTf, tfs, deriv, alignment) };
}
