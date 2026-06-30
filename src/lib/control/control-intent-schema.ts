import * as v from 'valibot';

// Schema COMPLETO: lo produce el parser slash determinista y lo consume dispatchControl. Incluye los
// comandos que tocan dinero (cierra) y el argumento opcional symbol (solo lo puebla el slash).
export const ControlIntentSchema = v.object({
  command: v.picklist(['estado', 'pausa', 'reanuda', 'cierra', 'modo', 'unknown']),
  symbol: v.optional(v.string()),
});
export type ControlIntent = v.InferOutput<typeof ControlIntentSchema>;

// Schema ESTRICTO (FIX H1): es el que ve el LLM como `result` de session.skill. NO incluye `cierra` ni
// `symbol` → el modelo es estructuralmente incapaz de emitir un cierre. El slash es el único productor
// de {command:'cierra'}.
export const ControlResultSchema = v.object({
  command: v.picklist(['estado', 'pausa', 'reanuda', 'modo', 'unknown']),
});
export type ControlResult = v.InferOutput<typeof ControlResultSchema>;

export function parseControlIntent(raw: unknown): ControlIntent {
  return v.parse(ControlIntentSchema, raw);
}
