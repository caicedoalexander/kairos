// flue-blueprint: channel/evolution@1
import type { Handler } from 'hono';
import { appendAuditLog } from '../db/repositories/audit-log.ts';
import { parseSlashCommand } from '../lib/control/parse-control.ts';
import { dispatchControl, type DispatchDeps } from '../lib/control/dispatch-control.ts';
import type { ControlIntent } from '../lib/control/control-intent-schema.ts';
import { closePositionCommand } from '../lib/control/close-position-command.ts';
import { cancelOco } from '../lib/execution/real-order/cancel-oco.ts';
import { emergencyClose } from '../lib/execution/real-order/emergency-close.ts';
import { getAuthenticatedClient } from '../lib/ccxt-client.ts';
import type { RealClient } from '../lib/execution/execute-order-real.ts';
import type { OrderStateClient } from '../lib/execution/real-order/order-state.ts';
import type { CancelOcoClient } from '../lib/execution/real-order/cancel-oco.ts';
import { getOpenPositions } from '../db/repositories/positions.ts';
import { setPaused } from '../db/repositories/bot-state.ts';
import { getMode } from '../lib/mode.ts';
import { sendWhatsApp } from '../notify/whatsapp.ts';

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

// H2: descarta la propia respuesta saliente del bot (evita el lazo de realimentación).
export function isFromMe(body: unknown): boolean {
  return (body as { data?: { key?: { fromMe?: boolean } } })?.data?.key?.fromMe === true;
}

// L2: extrae el texto del mensaje (dos formas reales del payload Evolution).
export function extractMessageText(body: unknown): string | null {
  const m = (body as { data?: { message?: { conversation?: string; extendedTextMessage?: { text?: string } } } })?.data?.message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? null;
}

interface ControlRouteDeps {
  dispatch: (intent: ControlIntent, deps: DispatchDeps) => Promise<string>;
  reply: (text: string, to: string) => Promise<unknown>;
  invoke: (text: string, sender: string) => Promise<unknown>;
}

// Construye el dep de cierre. En modo real arma el cliente ccxt (credenciales en closure); en sim no.
// Garantía de seguridad: en sim no se construye el cliente autenticado (no hay keys → lanzaría).
async function closePositionDep(symbol: string): Promise<string> {
  const mode = getMode();
  if (mode === 'sim') {
    return closePositionCommand(symbol, { mode, cancelOco, emergencyClose });
  }
  const client = getAuthenticatedClient();
  await client.loadMarkets();
  return closePositionCommand(symbol, {
    mode,
    client: client as unknown as RealClient & OrderStateClient & CancelOcoClient,
    cancelOco,
    emergencyClose,
  });
}

const DEFAULT_ROUTE: ControlRouteDeps = {
  dispatch: dispatchControl,
  reply: (text, to) => sendWhatsApp(text, to),
  invoke: async (text, sender) => {
    const { invoke } = await import('@flue/runtime');
    const controlMaker = (await import('../workflows/control-maker.ts')).default;
    return invoke(controlMaker, { input: { text, sender } });
  },
};

// Rutea el mensaje: comando slash → dispatch determinista + reply; texto libre → invoke (LLM).
export async function processControlMessage(
  text: string, sender: string, route: ControlRouteDeps = DEFAULT_ROUTE,
): Promise<void> {
  const slash = parseSlashCommand(text);
  if (slash) {
    // H-1: getOpenPositions exige `mode`; se envuelve con getMode().
    // closePositionDep construye el cliente ccxt solo en modo real (credenciales en closure).
    const replyText = await route.dispatch(slash, {
      getOpenPositions: () => getOpenPositions(getMode()),
      setPaused,
      closePosition: closePositionDep,
      currentMode: getMode(),
    });
    await route.reply(replyText, sender);
  } else {
    await route.invoke(text, sender); // texto libre → control-maker (Haiku)
  }
}

// Lógica del webhook: verificar → descartar fromMe → autorizar → auditar → dispatch best-effort.
export async function handleEvolutionWebhook(
  headers: Headers,
  body: unknown,
): Promise<{ status: number }> {
  if (!verifyEvolutionWebhook(headers)) return { status: 401 };
  if (isFromMe(body)) return { status: 200 }; // H2: evita lazo con los mensajes salientes propios
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
  const text = extractMessageText(body);
  if (text && sender) {
    // M2: ack-then-process — no bloquear el 200 con DB/fetch saliente; best-effort.
    void processControlMessage(text, sender).catch((err) => {
      void appendAuditLog({
        eventType: 'control_dispatch_failed',
        actor: sender,
        payload: { error: err instanceof Error ? err.message : String(err) },
      }).catch(() => {});
    });
  }
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
