import { describe, it, expect } from 'vitest';
import { computeTrailingSl } from './trailing.ts';
import type { TrailingConfig } from './trailing-config.ts';

const cfg: TrailingConfig = { enabled: true, activation_pct: 0.01, distance_pct: 0.015, min_step_pct: 0.003 };

describe('computeTrailingSl', () => {
  it('no activa si el precio no superó entry*(1+activation)', () => {
    // entry 100, activación a 101; precio 100.5 < 101
    expect(computeTrailingSl({ entry: 100, currentSl: 95, price: 100.5, cfg })).toBeNull();
  });

  it('sube el SL cuando el candidato supera el SL vigente por min_step', () => {
    // precio 110 (>101), candidato = 110*(1-0.015) = 108.35; SL viejo 95 → sube
    expect(computeTrailingSl({ entry: 100, currentSl: 95, price: 110, cfg })).toBeCloseTo(108.35, 6);
  });

  it('NO baja: si el candidato < SL vigente → null', () => {
    // precio 110 → candidato 108.35; SL vigente 109 (> candidato) → null (nunca baja)
    expect(computeTrailingSl({ entry: 100, currentSl: 109, price: 110, cfg })).toBeNull();
  });

  it('NO se mueve por micro-paso (< min_step sobre el SL vigente)', () => {
    // candidato 108.35; SL vigente 108.2; 108.2*(1+0.003)=108.5246 > 108.35 → null (no supera min_step)
    expect(computeTrailingSl({ entry: 100, currentSl: 108.2, price: 110, cfg })).toBeNull();
  });

  it('el candidato siempre queda bajo el precio', () => {
    const sl = computeTrailingSl({ entry: 100, currentSl: 95, price: 110, cfg });
    expect(sl).not.toBeNull();
    expect(sl as number).toBeLessThan(110);
  });
});
