import { defineAgent, defineAgentProfile, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import decisionProtocol from '../skills/decision-protocol/SKILL.md' with { type: 'skill' };
import technicalRead from '../skills/technical-read/SKILL.md' with { type: 'skill' };
import fundamentalRead from '../skills/fundamental-read/SKILL.md' with { type: 'skill' };
import { evaluateWithFailover, type SkillSession } from '../lib/reasoning/evaluate-with-failover.ts';
import { analyzeTechnical, type TaskSession } from '../lib/reasoning/analyze-technical.ts';
import { analyzeFundamental, type FundamentalTaskSession } from '../lib/reasoning/analyze-fundamental.ts';
import { isMajorCap, shouldRunFundamental } from '../lib/reasoning/fundamental-gate.ts';
import { fetchCryptoPanicNews } from '../lib/sources/cryptopanic.ts';
import { runDecisionMaker, type DecisionMakerDeps } from '../lib/reasoning/run-decision-maker.ts';
import { getSignalById } from '../db/repositories/signals.ts';
import { getStrategy } from '../db/repositories/strategies.ts';
import { insertShadowVerdict, isAlreadyEvaluated } from '../db/repositories/shadow-verdicts.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

// Modelos por env (§9): no hardcodear el id exacto. Failover reintenta el mismo modelo si no hay escalación.
const DECISION_MODEL = process.env.DECISION_MODEL ?? 'anthropic/claude-sonnet-4-6';
const ESCALATION = process.env.DECISION_MODEL_ESCALATION;
const MODELS = ESCALATION ? [DECISION_MODEL, ESCALATION] : [DECISION_MODEL, DECISION_MODEL];
// Analistas: Haiku, thinking medium (§287). Explícitos para NO heredar Sonnet/high del padre.
const TECHNICAL_MODEL = process.env.TECHNICAL_MODEL ?? 'anthropic/claude-haiku-4-5';
const FUNDAMENTAL_MODEL = process.env.FUNDAMENTAL_MODEL ?? 'anthropic/claude-haiku-4-5';

// Subagentes: SOLO lectura. tools:[] = línea roja (no pueden mutar dinero ni leer-con-efecto).
const technicalAnalyst = defineAgentProfile({
  name: 'technical-analyst',
  description: 'Interpreta el snapshot de indicadores ya computado y emite un technical_read cualitativo. Solo lectura.',
  model: TECHNICAL_MODEL,
  thinkingLevel: 'medium',
  skills: [technicalRead],
  tools: [],
});

const fundamentalAnalyst = defineAgentProfile({
  name: 'fundamental-analyst',
  description: 'Lee catalizadores (noticias) y posicionamiento (funding/OI) de un major-cap y emite un fundamental_read. Solo lectura.',
  model: FUNDAMENTAL_MODEL,
  thinkingLevel: 'medium',
  skills: [fundamentalRead],
  tools: [],
});

const decisionAgent = defineAgent(() => ({
  model: DECISION_MODEL,
  thinkingLevel: 'high',
  skills: [decisionProtocol],
  subagents: [technicalAnalyst, fundamentalAnalyst],
  // SIN tools de mutación: el decision-maker solo emite veredicto (línea roja).
}));

export default defineWorkflow({
  agent: decisionAgent,
  input: v.object({ signalId: v.string() }),
  output: v.object({ outcome: v.picklist(['persisted', 'not_found', 'duplicate', 'failed']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    // Sesiones dedicadas por analista (R2): transcript del decision-maker limpio. Los subagentes
    // están disponibles porque se registran en el AGENTE, no en la sesión.
    const techSession = (await harness.session('technical')) as unknown as TaskSession;
    const fundSession = (await harness.session('fundamental')) as unknown as FundamentalTaskSession;
    const deps: DecisionMakerDeps = {
      getSignal: getSignalById,
      getStrategy,
      isAlreadyEvaluated,
      analyze: (args) => analyzeTechnical(techSession, args as unknown as Record<string, unknown>, TECHNICAL_MODEL),
      isMajorCap,
      fetchNews: (symbol) => fetchCryptoPanicNews(symbol),
      shouldRunFundamental,
      analyzeFundamental: (fargs) => analyzeFundamental(fundSession, fargs as unknown as Record<string, unknown>, FUNDAMENTAL_MODEL),
      evaluate: (args) => evaluateWithFailover(session, args as unknown as Record<string, unknown>, MODELS),
      persist: insertShadowVerdict,
      audit: appendAuditLog,
    };
    const result = await runDecisionMaker(input.signalId, deps);
    return { outcome: result.kind };
  },
});
