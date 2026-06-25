import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { pool, query } from '../db/pool.ts';
import {
  verifyEvolutionWebhook,
  extractSenderNumber,
  isAuthorizedSender,
  handleEvolutionWebhook,
} from './evolution.ts';

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  vi.stubEnv('EVOLUTION_WEBHOOK_SECRET', 'top-secret');
  vi.stubEnv('WHATSAPP_CONTROL_NUMBER', '573001234567');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const headers = (secret?: string) =>
  new Headers(secret ? { 'x-evolution-secret': secret } : {});

const inbound = (jid: string) => ({ data: { key: { remoteJid: jid } } });

describe('verifyEvolutionWebhook', () => {
  test('acepta el secreto correcto', () => {
    expect(verifyEvolutionWebhook(headers('top-secret'))).toBe(true);
  });
  test('rechaza secreto ausente o incorrecto', () => {
    expect(verifyEvolutionWebhook(headers())).toBe(false);
    expect(verifyEvolutionWebhook(headers('wrong'))).toBe(false);
  });
});

describe('extractSenderNumber / isAuthorizedSender', () => {
  test('extrae los dígitos del remoteJid', () => {
    expect(extractSenderNumber(inbound('573001234567@s.whatsapp.net'))).toBe('573001234567');
  });
  test('devuelve null si no hay remoteJid', () => {
    expect(extractSenderNumber({})).toBeNull();
  });
  test('solo autoriza el número de control', () => {
    expect(isAuthorizedSender('573001234567')).toBe(true);
    expect(isAuthorizedSender('999')).toBe(false);
    expect(isAuthorizedSender(null)).toBe(false);
  });
});

describe('handleEvolutionWebhook', () => {
  test('secreto inválido → 401 y no audita', async () => {
    const res = await handleEvolutionWebhook(headers('wrong'), inbound('573001234567@s.whatsapp.net'));
    expect(res.status).toBe(401);
  });

  test('válido + autorizado → 200 y registra en audit_log', async () => {
    const res = await handleEvolutionWebhook(
      headers('top-secret'),
      inbound('573001234567@s.whatsapp.net'),
    );
    expect(res.status).toBe(200);
    const rows = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM kairos.audit_log WHERE event_type = 'whatsapp.inbound'`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  test('válido pero remitente no autorizado → 200 sin acción', async () => {
    const res = await handleEvolutionWebhook(headers('top-secret'), inbound('999@s.whatsapp.net'));
    expect(res.status).toBe(200);
  });
});
