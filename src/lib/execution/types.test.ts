import { describe, test, expect } from 'vitest';
import * as v from 'valibot';
import { parseRiskParams, SimParamsSchema, VerdictSchema } from './types.ts';
import { DEFAULT_SIM_PARAMS, MAX_RISK_PER_TRADE } from './limits.ts';

const VALID_RISK = {
  risk_per_trade_pct: 0.5, atr_stop_mult: 1.5, tp_r_multiple: 2,
  max_notional_pct: 10, max_total_exposure_pct: 30, max_open_positions: 3,
  max_symbol_exposure_pct: 15, max_daily_loss_pct: 3, max_drawdown_pct: 15,
  max_consecutive_losses: 4,
};

describe('parseRiskParams', () => {
  test('acepta config válida', () => {
    expect(parseRiskParams(VALID_RISK).tp_r_multiple).toBe(2);
  });
  test('lanza si falta un campo requerido', () => {
    const { tp_r_multiple, ...incomplete } = VALID_RISK;
    expect(() => parseRiskParams(incomplete)).toThrow();
  });
  test('lanza si max_open_positions no es entero', () => {
    expect(() => parseRiskParams({ ...VALID_RISK, max_open_positions: 2.5 })).toThrow();
  });
});

describe('VerdictSchema', () => {
  test('rechaza sizingFactor > 1', () => {
    expect(() => v.parse(VerdictSchema, { action: 'enter', entry: 100, sl: 95, tp: 110, sizingFactor: 1.5 })).toThrow();
  });
});

describe('limits + SimParams', () => {
  test('DEFAULT_SIM_PARAMS es un SimParams válido', () => {
    expect(v.parse(SimParamsSchema, DEFAULT_SIM_PARAMS).fee_bps).toBe(10);
  });
  test('MAX_RISK_PER_TRADE es 2.0', () => {
    expect(MAX_RISK_PER_TRADE).toBe(2.0);
  });
});
