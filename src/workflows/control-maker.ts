import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import controlProtocol from '../skills/control-protocol/SKILL.md' with { type: 'skill' };
import { ControlIntentSchema, type ControlIntent } from '../lib/control/control-intent-schema.ts';
import { dispatchControl } from '../lib/control/dispatch-control.ts';
import { getOpenPositions } from '../db/repositories/positions.ts';
import { setPaused } from '../db/repositories/bot-state.ts';
import { getMode } from '../lib/mode.ts';
import { sendWhatsApp } from '../notify/whatsapp.ts';
import { appendAuditLog } from '../db/repositories/audit-log.ts';

const CONTROL_MODEL = process.env.CONTROL_MODEL ?? 'anthropic/claude-haiku-4-5';

// Agente de control: clasifica intención. tools:[] = línea roja (no ejecuta; el código despacha).
const controlAgent = defineAgent(() => ({
  model: CONTROL_MODEL,
  thinkingLevel: 'low',
  skills: [controlProtocol],
  tools: [],
}));

// Interfaz mínima de sesión para session.skill con result.
interface SkillSession {
  skill(name: string, opts: { args: Record<string, unknown>; result: unknown }): Promise<{ data: ControlIntent }>;
}

export default defineWorkflow({
  agent: controlAgent,
  input: v.object({ text: v.string(), sender: v.string() }),
  output: v.object({ command: v.picklist(['estado', 'pausa', 'reanuda', 'unknown']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    // L3: si el skill no produce un ControlIntent válido, degrada a 'unknown' (responde ayuda).
    let intent: ControlIntent = { command: 'unknown' };
    try {
      const res = await session.skill('control-protocol', { args: { text: input.text }, result: ControlIntentSchema });
      intent = res.data;
    } catch (err: unknown) {
      try {
        await appendAuditLog({ eventType: 'control_parse_failed', actor: 'control-maker',
          payload: { sender: input.sender, error: err instanceof Error ? err.message : String(err) } });
      } catch { /* best-effort */ }
    }
    // H-1: getOpenPositions exige `mode`; se envuelve con getMode() para satisfacer DispatchDeps.
    const reply = await dispatchControl(intent, { getOpenPositions: () => getOpenPositions(getMode()), setPaused });
    try {
      await sendWhatsApp(reply, input.sender);
    } catch { /* best-effort: el control no tumba nada si Evolution falla */ }
    return { command: intent.command };
  },
});
