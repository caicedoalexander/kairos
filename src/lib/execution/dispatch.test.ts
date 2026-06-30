import { describe, it, expect } from 'vitest';
import { isRealMode } from './dispatch.ts';

describe('isRealMode', () => {
  it('testnet y live son modos reales', () => {
    expect(isRealMode('testnet')).toBe(true);
    expect(isRealMode('live')).toBe(true);
  });
  it('sim no es modo real', () => {
    expect(isRealMode('sim')).toBe(false);
  });
});
