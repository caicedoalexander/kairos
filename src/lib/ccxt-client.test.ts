import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createPublicClient, createAuthenticatedClient } from './ccxt-client.ts';

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('ccxt-client', () => {
  test('el cliente público no lleva API key', () => {
    const client = createPublicClient();
    expect(client.apiKey ?? '').toBe('');
  });

  test('el cliente autenticado toma la credencial del entorno', () => {
    vi.stubEnv('KAIROS_MODE', 'testnet');
    vi.stubEnv('BINANCE_API_KEY', 'k-123');
    vi.stubEnv('BINANCE_API_SECRET', 's-456');
    const client = createAuthenticatedClient();
    expect(client.apiKey).toBe('k-123');
    expect(client.secret).toBe('s-456');
  });

  test('lanza si faltan las credenciales del exchange', () => {
    vi.stubEnv('KAIROS_MODE', 'testnet');
    vi.stubEnv('BINANCE_API_KEY', '');
    vi.stubEnv('BINANCE_API_SECRET', '');
    expect(() => createAuthenticatedClient()).toThrow();
  });
});
