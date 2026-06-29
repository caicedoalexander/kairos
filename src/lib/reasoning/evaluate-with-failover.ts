import { LlmVerdictSchema, type LlmVerdict } from './verdict-schema.ts';

// Interfaz mínima de la sesión que necesitamos (subset de FlueSession.skill con result).
// La real viene de harness.session(); en tests se inyecta una falsa.
export interface SkillSession {
  skill(name: string, opts: { args: Record<string, unknown>; result: unknown; model?: string }): Promise<{
    data: LlmVerdict;
    usage: unknown;
    model: { provider: string; id: string };
  }>;
}

// Extrae el total de tokens de PromptUsage (`totalTokens` es el campo documentado; los fallbacks
// son conservadores ante versiones futuras).
function extractTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const t = u.totalTokens ?? u.total_tokens ?? u.tokens;
  return typeof t === 'number' ? t : null;
}

// Llama al skill decision-protocol probando los modelos en orden; devuelve el primer éxito.
// Failover = resiliencia ante error de proveedor o ResultUnavailableError (Sonnet→Opus si se
// configuró DECISION_MODEL_ESCALATION; si no, reintenta el mismo modelo).
// SP7: ambos intentos comparten la `session`; si el primero falla con ResultUnavailableError, el
// turno fallido queda en el historial y llega al reintento. Tolerable en sombra/best-effort; la
// sesión fresca por intento (sessionFactory) se introduce en SP10 cuando el failover pese más.
export async function evaluateWithFailover(
  session: SkillSession, args: Record<string, unknown>, models: string[],
): Promise<{ verdict: LlmVerdict; modelUsed: string; tokens: number | null }> {
  let lastErr: unknown = new Error('evaluateWithFailover: lista de modelos vacía');
  for (const model of models) {
    try {
      const res = await session.skill('decision-protocol', { args, result: LlmVerdictSchema, model });
      return { verdict: res.data, modelUsed: `${res.model.provider}/${res.model.id}`, tokens: extractTokens(res.usage) };
    } catch (err: unknown) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
