import { describe, test, expect } from 'vitest';
import { resolveBracket } from './bracket.ts';
import type { SimParams, PositionForResolve } from './types.ts';

const SP: SimParams = { spread_bps: 0, slippage_bps: 0, fee_bps: 0 }; // sin costos para aislar la lógica
const POS: PositionForResolve = { entry: 100, size: 2, sl: 95, tp: 110, entryFee: 0 };

describe('resolveBracket', () => {
  test('null cuando la vela no toca SL ni TP', () => {
    expect(resolveBracket(POS, { open: 100, high: 105, low: 98, close: 102 }, SP)).toBeNull();
  });
  test('TP: llena exacto a tp, pnl = (tp-entry)*size', () => {
    const r = resolveBracket(POS, { open: 105, high: 111, low: 104, close: 110 }, SP);
    expect(r).toMatchObject({ hitType: 'tp', exitPrice: 110, realizedPnl: 20 });
  });
  test('SL: llena al sl, pnl negativo', () => {
    const r = resolveBracket(POS, { open: 97, high: 98, low: 94, close: 95 }, SP);
    expect(r?.hitType).toBe('sl');
    expect(r?.exitPrice).toBe(95);       // ref = min(95, 97) = 95
    expect(r?.realizedPnl).toBe(-10);    // (95-100)*2
  });
  test('SL gana si la vela toca ambos (peor caso)', () => {
    expect(resolveBracket(POS, { open: 100, high: 111, low: 94, close: 105 }, SP)?.hitType).toBe('sl');
  });
  test('gap-through: abre debajo del SL → llena al open, no al SL', () => {
    const r = resolveBracket(POS, { open: 90, high: 92, low: 88, close: 91 }, SP);
    expect(r?.exitPrice).toBe(90);       // min(95, 90) = 90
    expect(r?.realizedPnl).toBe(-20);    // (90-100)*2
  });
  test('fees reducen el pnl', () => {
    const r = resolveBracket({ ...POS, entryFee: 1 }, { open: 105, high: 111, low: 104, close: 110 }, { spread_bps: 0, slippage_bps: 0, fee_bps: 10 });
    // exitFee = 110*2*0.001 = 0.22; pnl = 20 - 1 - 0.22 = 18.78
    expect(r?.realizedPnl).toBeCloseTo(18.78, 6);
  });
});
