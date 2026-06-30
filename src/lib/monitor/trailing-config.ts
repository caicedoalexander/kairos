import * as v from 'valibot';

// Config de trailing (opt-in) que vive en strategy.risk_params.trailing (jsonb). Bounds obligatorios
// (FIX M3): distance_pct en (0, 0.5], min_step_pct ≥ 0, activation_pct ≥ 0, todos finitos. Una misconfig
// (p.ej. min_step_pct negativo, que podría bajar el SL) hace fallar el parse → trailing off (fail-safe).
const TrailingConfigSchema = v.object({
  enabled: v.boolean(),
  activation_pct: v.pipe(v.number(), v.finite(), v.minValue(0)),
  distance_pct: v.pipe(v.number(), v.finite(), v.minValue(0.0001), v.maxValue(0.5)),
  min_step_pct: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

export type TrailingConfig = v.InferOutput<typeof TrailingConfigSchema>;

// Devuelve la config si es válida y enabled; null si ausente, inválida o disabled.
export function parseTrailingConfig(riskParams: Record<string, unknown>): TrailingConfig | null {
  const raw = riskParams.trailing;
  if (raw === undefined || raw === null) return null;
  const parsed = v.safeParse(TrailingConfigSchema, raw);
  if (!parsed.success || !parsed.output.enabled) return null;
  return parsed.output;
}
