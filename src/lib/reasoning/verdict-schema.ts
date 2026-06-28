import * as v from 'valibot';

// Veredicto del decision-maker LLM. Alineado con el Verdict determinista (action/entry/sl/tp/
// sizingFactor) para A/B directo, más los extras del LLM (confianza, razonamiento auditable).
// 'lado' (ARCHITECTURE §6) se omite: implícito 'long' (spot long-only); se añade con shorts.
export const LlmVerdictSchema = v.object({
  action: v.picklist(['enter', 'skip']),
  entry: v.number(),
  sl: v.number(),
  tp: v.number(),
  sizingFactor: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  confianza: v.picklist(['alta', 'media', 'baja']),
  razonamiento: v.string(),
});

export type LlmVerdict = v.InferOutput<typeof LlmVerdictSchema>;

export function parseLlmVerdict(raw: unknown): LlmVerdict {
  return v.parse(LlmVerdictSchema, raw);
}
