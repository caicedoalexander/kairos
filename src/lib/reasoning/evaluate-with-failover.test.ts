import { describe, test, expect, vi } from 'vitest';
import { evaluateWithFailover, type SkillSession } from './evaluate-with-failover.ts';
import type { LlmVerdict } from './verdict-schema.ts';

const VERDICT: LlmVerdict = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' };
function ok(model: string) { return { data: VERDICT, usage: { totalTokens: 50 }, model: { provider: model.split('/')[0], id: model.split('/')[1] } }; }

describe('evaluateWithFailover', () => {
  test('primer modelo OK → devuelve veredicto + modelUsed + tokens', async () => {
    const session: SkillSession = { skill: vi.fn(async (_n, opts) => ok(opts.model!)) };
    const r = await evaluateWithFailover(session, { symbol: 'BTC/USDT' }, ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-x']);
    expect(r.verdict).toEqual(VERDICT);
    expect(r.modelUsed).toBe('anthropic/claude-sonnet-4-6');
    expect(r.tokens).toBe(50);
    expect(session.skill).toHaveBeenCalledOnce(); // no escaló
  });

  test('primer modelo falla → reintenta el segundo', async () => {
    const skill = vi.fn()
      .mockRejectedValueOnce(new Error('provider 503'))
      .mockImplementationOnce(async (_n: string, opts: { model?: string }) => ok(opts.model!));
    const r = await evaluateWithFailover({ skill } as unknown as SkillSession, {}, ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-x']);
    expect(r.modelUsed).toBe('anthropic/claude-opus-x');
    expect(skill).toHaveBeenCalledTimes(2);
  });

  test('todos fallan → lanza el último error', async () => {
    const session: SkillSession = { skill: vi.fn(async () => { throw new Error('down'); }) };
    await expect(evaluateWithFailover(session, {}, ['a/b', 'c/d'])).rejects.toThrow('down');
  });
});
