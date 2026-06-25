// src/lib/scanner/rules-engine.ts
import type { TriggerConfig, RuleNode, Features } from './types.ts';
import { predicates, type PredicateCtx } from './predicates.ts';

// Evalúa un nodo del árbol. Hoja: resuelve features[tf] (o el TF gatillo) y aplica el predicado.
function evaluateNode(
  node: RuleNode, featuresByTf: Record<string, Features>, triggerTf: string, ctx: PredicateCtx,
): boolean {
  if ('all' in node) return node.all.every((n) => evaluateNode(n, featuresByTf, triggerTf, ctx));
  if ('any' in node) return node.any.some((n) => evaluateNode(n, featuresByTf, triggerTf, ctx));
  const features = featuresByTf[node.tf ?? triggerTf];
  if (!features) return false;
  const fn = predicates[node.predicate];
  if (!fn) throw new Error(`predicado desconocido: ${node.predicate}`);
  return fn(features, node.args ?? {}, ctx);
}

export function evaluateEntry(
  config: TriggerConfig, featuresByTf: Record<string, Features>, triggerTf: string, ctx: PredicateCtx,
): boolean {
  return evaluateNode(config.entry, featuresByTf, triggerTf, ctx);
}

// Veto duro: skip ausente = sin veto (false).
export function evaluateSkip(
  config: TriggerConfig, featuresByTf: Record<string, Features>, triggerTf: string, ctx: PredicateCtx,
): boolean {
  return config.skip ? evaluateNode(config.skip, featuresByTf, triggerTf, ctx) : false;
}
