// Placeholder del workflow principal de Kairos.
// Implementación real en Task 5+ (scanner → decision-maker → execute_order).
import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';

export default defineWorkflow({
  agent: defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' })),
  input: v.object({ symbol: v.string() }),
  output: v.object({ verdict: v.string() }),

  async run({ input }) {
    // Stub: el loop determinista (sin LLM) se implementa en la Fase 0 completa.
    return { verdict: `pending:${input.symbol}` };
  },
});
