import { FundamentalReadSchema, type FundamentalRead } from './fundamental-read-schema.ts';
import { extractTokens } from './evaluate-with-failover.ts';

// Interfaz mínima de la sesión para delegar al subagente fundamental. CLON (L1) de la TaskSession de
// analyze-technical, tipada a FundamentalRead (no se reutiliza literal: daría mismatch de tipos).
export interface FundamentalTaskSession {
  task(text: string, opts: { agent: string; result: unknown; model?: string }): Promise<{
    data: FundamentalRead;
    usage: unknown;
    model: { provider: string; id: string };
  }>;
}

// El subagente recibe las noticias + derivados en el texto del prompt; su skill `fundamental-read`
// le dice CÓMO leerlos (catalizador vs ruido, decaimiento, posicionamiento). Juzga, no calcula.
export async function analyzeFundamental(
  session: FundamentalTaskSession, args: Record<string, unknown>, model?: string, // si se omite, usa el modelo del profile
): Promise<{ read: FundamentalRead; modelUsed: string; tokens: number | null }> {
  const text =
    'Evalúa la lectura fundamental de este candidato (noticias + posicionamiento) y emite el ' +
    'fundamental_read estructurado según el protocolo del skill fundamental-read.\n\nDatos:\n' +
    JSON.stringify(args);
  const res = await session.task(text, { agent: 'fundamental-analyst', result: FundamentalReadSchema, model });
  return { read: res.data, modelUsed: `${res.model.provider}/${res.model.id}`, tokens: extractTokens(res.usage) };
}
