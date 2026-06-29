import { TechnicalReadSchema, type TechnicalRead } from './technical-read-schema.ts';
import { extractTokens } from './evaluate-with-failover.ts';

// Interfaz mínima de la sesión para delegar al subagente (subset de FlueSession.task con result).
// La real viene de harness.session('technical'); en tests se inyecta una falsa.
export interface TaskSession {
  task(text: string, opts: { agent: string; result: unknown; model?: string }): Promise<{
    data: TechnicalRead;
    usage: unknown;
    model: { provider: string; id: string };
  }>;
}

// El subagente recibe el snapshot ya computado en el texto del prompt; su skill `technical-read`
// (en su profile) le dice CÓMO interpretarlo. Juzga, no calcula. Sin failover propio en SP8 —
// la degradación la maneja runDecisionMaker (best-effort).
export async function analyzeTechnical(
  session: TaskSession, args: Record<string, unknown>, model?: string,
): Promise<{ read: TechnicalRead; modelUsed: string; tokens: number | null }> {
  const text =
    'Evalúa la lectura técnica de este candidato y emite el technical_read estructurado ' +
    'según el protocolo del skill technical-read.\n\nDatos del candidato (snapshot ya computado):\n' +
    JSON.stringify(args);
  const res = await session.task(text, { agent: 'technical-analyst', result: TechnicalReadSchema, model });
  return { read: res.data, modelUsed: `${res.model.provider}/${res.model.id}`, tokens: extractTokens(res.usage) };
}
