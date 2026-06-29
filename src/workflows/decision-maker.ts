import { defineAgent, defineAgentProfile, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import decisionProtocol from '../skills/decision-protocol/SKILL.md' with { type: 'skill' };
import technicalRead from '../skills/technical-read/SKILL.md' with { type: 'skill' };
import { evaluateWithFailover, type SkillSession } from '../lib/reasoning/evaluate-with-failover.ts';
import { analyzeTechnical, type TaskSession } from '../lib/reasoning/analyze-technical.ts';
import { runDecisionMaker, type DecisionMakerDeps } from '../lib/reasoning/run-decision-maker.ts';
import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { insertShadowVerdict, isAlreadyEvaluated } from '../db/repositories/shadow-verdicts.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Modelos por env (§9): no hardcodear el id exacto. Failover reintenta el mismo modelo si no hay escalación.
const DECISION_MODEL = process.env.DECISION_MODEL ?? 'anthropic/claude-sonnet-4-6';
const ESCALATION = process.env.DECISION_MODEL_ESCALATION;
const MODELS = ESCALATION ? [DECISION_MODEL, ESCALATION] : [DECISION_MODEL, DECISION_MODEL];
// Analista técnico: Haiku, thinking medium (ARCHITECTURE §287). Explícito para NO heredar Sonnet/high.
const TECHNICAL_MODEL = process.env.TECHNICAL_MODEL ?? 'anthropic/claude-haiku-4-5';

// Subagente técnico: SOLO lectura del snapshot que recibe en el prompt. tools:[] = línea roja
// (no puede mutar dinero ni leer-con-efecto). Su skill technical-read le da la doctrina.
const technicalAnalyst = defineAgentProfile({
  name: 'technical-analyst',
  description: 'Interpreta el snapshot de indicadores ya computado y emite un technical_read cualitativo. Solo lectura.',
  model: TECHNICAL_MODEL,
  thinkingLevel: 'medium',
  skills: [technicalRead],
  tools: [],
});

const decisionAgent = defineAgent(() => ({
  model: DECISION_MODEL,
  thinkingLevel: 'high',
  skills: [decisionProtocol],
  subagents: [technicalAnalyst],
  // SIN tools de mutación: el decision-maker solo emite veredicto (línea roja).
}));

export default defineWorkflow({
  agent: decisionAgent,
  input: v.object({ signalId: v.string() }),
  output: v.object({ outcome: v.picklist(['persisted', 'not_found', 'duplicate', 'failed']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    // Sesión dedicada para el analista (R2): mantiene el transcript del decision-maker limpio y
    // determinista. El subagente está disponible porque se registra en el AGENTE, no en la sesión.
    const techSession = (await harness.session('technical')) as unknown as TaskSession;
    const deps: DecisionMakerDeps = {
      getSignal: getSignalById,
      getStrategy,
      isAlreadyEvaluated,
      analyze: (args) => analyzeTechnical(techSession, args as unknown as Record<string, unknown>, TECHNICAL_MODEL),
      // SP9-Task7 reemplaza estos stubs con el cableado real (profile fundamental + sesión dedicada):
      isMajorCap: () => false,
      fetchNews: async () => ({ items: [], ok: false }),
      shouldRunFundamental: () => false,
      analyzeFundamental: async () => { throw new Error('SP9-Task7 pendiente: cableado de analyzeFundamental'); },
      evaluate: (args) => evaluateWithFailover(session, args as unknown as Record<string, unknown>, MODELS),
      persist: insertShadowVerdict,
      audit: appendAuditLog,
    };
    const result = await runDecisionMaker(input.signalId, deps);
    return { outcome: result.kind };
  },
});
