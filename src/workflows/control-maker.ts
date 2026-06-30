import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import controlProtocol from '../skills/control-protocol/SKILL.md' with { type: 'skill' };
import { ControlResultSchema, type ControlResult } from '../lib/control/control-intent-schema.ts';
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
  skill(name: string, opts: { args: Record<string, unknown>; result: unknown }): Promise<{ data: ControlResult }>;
}

export default defineWorkflow({
  agent: controlAgent,
  input: v.object({ text: v.string(), sender: v.string() }),
  // FIX H1: el output del workflow refleja ControlResultSchema (sin 'cierra') — el LLM nunca puede
  // emitir un cierre; ese comando solo llega por el parser slash determinista.
  output: v.object({ command: v.picklist(['estado', 'pausa', 'reanuda', 'modo', 'unknown']) }),

  async run({ harness, input }) {
    const session = (await harness.session()) as unknown as SkillSession;
    // L3: si el skill no produce un ControlResult válido, degrada a 'unknown' (responde ayuda).
    let intent: ControlResult = { command: 'unknown' };
    try {
      // FIX H1: result usa ControlResultSchema (estricto, sin 'cierra') — el LLM ve solo el picklist
      // seguro. El único productor de {command:'cierra'} es el parser slash determinista.
      const res = await session.skill('control-protocol', { args: { text: input.text }, result: ControlResultSchema });
      intent = res.data;
    } catch (err: unknown) {
      try {
        await appendAuditLog({ eventType: 'control_parse_failed', actor: 'control-maker',
          payload: { sender: input.sender, error: err instanceof Error ? err.message : String(err) } });
      } catch { /* best-effort */ }
    }
    // H-1: getOpenPositions exige `mode`; se envuelve con getMode() para satisfacer DispatchDeps.
    // closePosition: stub — el LLM nunca emite 'cierra' (Task 7 lo reemplaza en evolution.ts).
    const reply = await dispatchControl(intent, {
      getOpenPositions: () => getOpenPositions(getMode()),
      setPaused,
      closePosition: async () => 'Para cerrar una posición usa /cierra <símbolo>.',
      currentMode: getMode(),
    });
    try {
      await sendWhatsApp(reply, input.sender);
    } catch { /* best-effort: el control no tumba nada si Evolution falla */ }
    return { command: intent.command };
  },
});
