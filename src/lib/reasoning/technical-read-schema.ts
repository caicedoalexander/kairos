import * as v from 'valibot';

// Lectura técnica cualitativa del subagente analista (§16.5). Categóricos para que el A/B (SP10)
// los agregue; mtfNote/notes libres y auditables. El analista JUZGA el snapshot ya computado, no
// recalcula indicadores.
export const TechnicalReadSchema = v.object({
  bias: v.picklist(['bullish', 'neutral', 'bearish']),       // lectura direccional
  confluence: v.picklist(['strong', 'moderate', 'weak']),    // cuántas familias apuntan igual
  regime: v.picklist(['trending', 'ranging']),               // ADX/BB
  divergence: v.picklist(['none', 'bullish', 'bearish']),    // precio vs momentum
  mtfNote: v.pipe(v.string(), v.minLength(1)),               // lectura de la alineación MTF
  notes: v.pipe(v.string(), v.minLength(1)),                 // 1-3 frases cualitativas
});

export type TechnicalRead = v.InferOutput<typeof TechnicalReadSchema>;

export function parseTechnicalRead(raw: unknown): TechnicalRead {
  return v.parse(TechnicalReadSchema, raw);
}
