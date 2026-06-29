import * as v from 'valibot';

// Intención de control parseada de un mensaje de WhatsApp. Picklist CERRADO: el LLM solo clasifica
// a uno de estos comandos seguros (el código ejecuta). 'unknown' = no soportado / no claro.
export const ControlIntentSchema = v.object({
  command: v.picklist(['estado', 'pausa', 'reanuda', 'unknown']),
});

export type ControlIntent = v.InferOutput<typeof ControlIntentSchema>;

export function parseControlIntent(raw: unknown): ControlIntent {
  return v.parse(ControlIntentSchema, raw);
}
