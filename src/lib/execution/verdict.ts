import type { Signal, Strategy } from '../scanner/types.ts';
import { parseRiskParams, type Verdict } from './types.ts';

// Productor de veredicto determinista (análogo al decision-maker LLM, sin LLM).
// Lee entry/atr del TF trigger del snapshot; deriva SL (stop ATR) y TP (R-múltiplo).
export function buildDeterministicVerdict(signal: Signal, strategy: Strategy): Verdict {
  const triggerTf = strategy.triggerConfig.timeframes.trigger;
  const f = signal.snapshot.byTimeframe[triggerTf];
  const entry = f?.close ?? null;
  const atrPct = f?.atrPct ?? null;

  if (entry === null || entry <= 0 || atrPct === null || atrPct <= 0) {
    return { action: 'skip', entry: 0, sl: 0, tp: 0, sizingFactor: 1, reason: 'atr/entry inválidos' };
  }

  const rp = parseRiskParams(strategy.riskParams);
  const atrAbs = (atrPct / 100) * entry;          // atrPct viene en puntos porcentuales
  const stopDistance = rp.atr_stop_mult * atrAbs;
  const sl = entry - stopDistance;                 // long-only: SL debajo
  const tp = entry + rp.tp_r_multiple * stopDistance;
  return { action: 'enter', entry, sl, tp, sizingFactor: 1.0 };
}
