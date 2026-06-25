// src/lib/scanner/config-schema.ts
import * as v from 'valibot';
import { predicates } from './predicates.ts';
import type { TriggerConfig, RuleNode } from './types.ts';

const knownPredicate = v.custom<string>(
  (name) => typeof name === 'string' && name in predicates,
  'predicado desconocido',
);

const leafSchema = v.object({
  tf: v.optional(v.string()),
  predicate: knownPredicate,
  args: v.optional(v.record(v.string(), v.number())),
});

// v.lazy en valibot 1.x recibe el input como argumento; lo ignoramos para la recursión.
const nodeSchema: v.GenericSchema<RuleNode> = v.lazy((_input) =>
  v.union([
    v.object({ all: v.array(nodeSchema) }),
    v.object({ any: v.array(nodeSchema) }),
    leafSchema,
  ]),
);

const triggerConfigSchema = v.object({
  timeframes: v.object({ bias: v.string(), context: v.string(), trigger: v.string() }),
  entry: nodeSchema,
  skip: v.optional(nodeSchema),
  allow_counter: v.optional(v.boolean()),
});

// Valida el trigger_config (dato externo de la fila strategies) en el límite. Lanza si es inválido.
export function parseTriggerConfig(raw: unknown): TriggerConfig {
  return v.parse(triggerConfigSchema, raw) as TriggerConfig;
}
