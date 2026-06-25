import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export interface SendResult {
  messageId: string | null;
}

// Envío determinista por el REST de Evolution (lo usa el notificador por template).
export async function sendWhatsApp(text: string, to?: string): Promise<SendResult> {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  const number = to ?? process.env.WHATSAPP_CONTROL_NUMBER;
  if (!baseUrl || !apiKey || !instance || !number) {
    throw new Error('Configuración de Evolution incompleta (URL/KEY/INSTANCE/NUMBER)');
  }

  // Evolution API v2: POST /message/sendText/{instance}, header apikey, body { number, text }.
  const res = await fetch(`${baseUrl}/message/sendText/${instance}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ number, text }),
  });
  if (!res.ok) {
    throw new Error(`Evolution respondió ${res.status}`);
  }

  const data = (await res.json()) as { key?: { id?: string } };
  return { messageId: data.key?.id ?? null };
}

// Tool de salida para el agente de control (Fase 2). No es una tool de mutación de dinero.
export const sendWhatsappTool = defineTool({
  name: 'send_whatsapp',
  description: 'Envía un mensaje de texto por WhatsApp al número de control vía Evolution API.',
  input: v.object({ text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) }),
  output: v.object({ messageId: v.nullable(v.string()) }),
  async run({ input }) {
    return await sendWhatsApp(input.text);
  },
});
