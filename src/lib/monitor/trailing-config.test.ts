import { describe, it, expect } from 'vitest';
import { parseTrailingConfig } from './trailing-config.ts';

describe('parseTrailingConfig', () => {
  const valid = { enabled: true, activation_pct: 0.01, distance_pct: 0.015, min_step_pct: 0.003 };

  it('parsea una config válida', () => {
    expect(parseTrailingConfig({ trailing: valid })).toEqual(valid);
  });
  it('null si no hay trailing', () => {
    expect(parseTrailingConfig({})).toBeNull();
  });
  it('null si enabled=false', () => {
    expect(parseTrailingConfig({ trailing: { ...valid, enabled: false } })).toBeNull();
  });
  it('null si distance_pct <= 0 (misconfig → fail-safe off)', () => {
    expect(parseTrailingConfig({ trailing: { ...valid, distance_pct: 0 } })).toBeNull();
  });
  it('null si min_step_pct negativo (protege el ratchet)', () => {
    expect(parseTrailingConfig({ trailing: { ...valid, min_step_pct: -0.001 } })).toBeNull();
  });
  it('null si distance_pct > 0.5', () => {
    expect(parseTrailingConfig({ trailing: { ...valid, distance_pct: 0.6 } })).toBeNull();
  });
});
