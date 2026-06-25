// flue-blueprint: channel/evolution@1
import type { Handler } from 'hono';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Verifica el secreto compartido del webhook (header x-evolution-secret vs. EVOLUTION_WEBHOOK_SECRET).
export function verifyEvolutionWebhook(headers: Headers): boolean {
  const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
  const received = headers.get('x-evolution-secret');
  return Boolean(expected) && received === expected;
}

// Extrae el número del remitente desde el remoteJid del payload de Evolution.
export function extractSenderNumber(body: unknown): string | null {
  const jid = (body as { data?: { key?: { remoteJid?: string } } })?.data?.key?.remoteJid;
  if (typeof jid !== 'string') return null;
  const digits = jid.split('@')[0]?.replace(/\D/g, '');
  return digits ? digits : null;
}

// Solo el número de control autorizado puede operar el bot.
export function isAuthorizedSender(number: string | null): boolean {
  return number !== null && number === process.env.WHATSAPP_CONTROL_NUMBER;
}

// Lógica del webhook: verificar → autorizar → auditar → status. dispatch al control = Fase 2.
export async function handleEvolutionWebhook(
  headers: Headers,
  body: unknown,
): Promise<{ status: number }> {
  if (!verifyEvolutionWebhook(headers)) {
    return { status: 401 };
  }
  const sender = extractSenderNumber(body);
  if (!isAuthorizedSender(sender)) {
    // Entrega válida pero no autorizada: se ignora silenciosamente (200 para no reintentar).
    return { status: 200 };
  }
  await appendAuditLog({
    eventType: 'whatsapp.inbound',
    actor: sender ?? 'unknown',
    payload: { received: true },
  });
  return { status: 200 };
}

// Binding Flue: adaptador delgado que traduce la petición HTTP a handleEvolutionWebhook.
// Path: /channels/evolution/webhook
// v8 ignore next 4 — glue de integración con Flue/Hono; se valida en el boot de Fase 1.
const webhook: Handler = async (c) => {
  const body: unknown = await c.req.json();
  const result = await handleEvolutionWebhook(c.req.raw.headers, body);
  return c.body(null, result.status as 200 | 401);
};

export const channel = {
  routes: [{ method: 'POST', path: '/webhook', handler: webhook }],
};
