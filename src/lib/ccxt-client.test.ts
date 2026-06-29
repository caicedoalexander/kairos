import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPublicClient, createAuthenticatedClient, createPerpPublicClient, getAuthenticatedClient, resetAuthenticatedClient } from './ccxt-client.ts';

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

describe('createPerpPublicClient', () => {
  test('crea un cliente público del perp USDM sin credenciales', () => {
    const client = createPerpPublicClient();
    expect(client.id).toBe('binanceusdm');
    expect(client.apiKey).toBeFalsy();
  });
});

describe('getAuthenticatedClient (singleton)', () => {
  const OLD = { ...process.env };
  beforeEach(() => { resetAuthenticatedClient(); process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's'; process.env.KAIROS_MODE = 'testnet'; });
  afterEach(() => { process.env = { ...OLD }; resetAuthenticatedClient(); });

  test('devuelve la MISMA instancia en llamadas repetidas', () => {
    expect(getAuthenticatedClient()).toBe(getAuthenticatedClient());
  });

  test('sandbox activo cuando KAIROS_MODE != live', () => {
    const c = getAuthenticatedClient();
    expect(c.urls['api']).not.toBe(undefined); // sandbox cambió urls
  });
});
