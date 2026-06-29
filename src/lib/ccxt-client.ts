import ccxt, { type Exchange } from 'ccxt';
import { getMode } from './mode.ts';

// Cliente PÚBLICO (sin API key): ingester de market-data y read tools de datos públicos (§7).
export function createPublicClient(): Exchange {
  return new ccxt.binance({ enableRateLimit: true });
}

// Cliente AUTENTICADO: credencial en closure, solo mutación + balance/estado (§7).
// El modelo nunca ve estas claves ni elige la cuenta.
export function createAuthenticatedClient(): Exchange {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) {
    throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET no configuradas');
  }
  const client = new ccxt.binance({ apiKey, secret, enableRateLimit: true });
  // sim y testnet usan el sandbox de Binance; solo live toca producción (§10).
  if (getMode() !== 'live') {
    client.setSandboxMode(true);
  }
  return client;
}

// Cliente PÚBLICO del mercado USDM perp (funding/OI read-only, §15). Sin API key.
export function createPerpPublicClient(): Exchange {
  return new ccxt.binanceusdm({ enableRateLimit: true });
}

let authClient: Exchange | null = null;

// Singleton autenticado: una sola instancia por proceso (el skill ccxt advierte que múltiples
// instancias con la misma key provocan conflictos de nonce). loadMarkets es perezoso (lo hace el caller).
export function getAuthenticatedClient(): Exchange {
  if (authClient) return authClient;
  authClient = createAuthenticatedClient();
  return authClient;
}

// Solo para tests: resetea el singleton.
export function resetAuthenticatedClient(): void { authClient = null; }
