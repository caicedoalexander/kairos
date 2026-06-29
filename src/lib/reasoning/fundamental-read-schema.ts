import * as v from 'valibot';

// Lectura fundamental del subagente (§17.4/§17.5). Centrada en catalizadores (noticias RSS) +
// posicionamiento (funding/OI ya en el snapshot). El analista JUZGA noticias y derivados, no calcula.
export const FundamentalReadSchema = v.object({
  bias: v.picklist(['bullish', 'neutral', 'bearish']),           // sesgo macro del conjunto leído
  catalysts: v.array(v.object({                                  // [] si no hay catalizador relevante
    title: v.pipe(v.string(), v.minLength(1)),
    sentiment: v.picklist(['bullish', 'neutral', 'bearish']),
    relevance: v.picklist(['high', 'medium', 'low']),
  })),
  positioning: v.picklist(['crowded_long', 'crowded_short', 'neutral']),  // lectura de funding/OI (§17.4)
  decayNote: v.optional(v.pipe(v.string(), v.minLength(1))),     // §17.5: frescura; ausente si catalysts=[]
  confidence: v.picklist(['alta', 'media', 'baja']),
});

export type FundamentalRead = v.InferOutput<typeof FundamentalReadSchema>;

export function parseFundamentalRead(raw: unknown): FundamentalRead {
  return v.parse(FundamentalReadSchema, raw);
}
