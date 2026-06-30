import { describe, it, expect } from 'vitest';
import { entryClientOrderId } from './client-order-id.ts';

describe('entryClientOrderId', () => {
  it('devuelve el signalId verbatim (clientOrderId determinista = idempotency_key)', () => {
    expect(entryClientOrderId('01J9ZX8K7Q2M3N4P5R6S7T8U9V')).toBe('01J9ZX8K7Q2M3N4P5R6S7T8U9V');
  });

  it('cabe en el límite de newClientOrderId de Binance (≤ 36 chars) para un ULID de 26', () => {
    expect(entryClientOrderId('01J9ZX8K7Q2M3N4P5R6S7T8U9V').length).toBeLessThanOrEqual(36);
  });
});
