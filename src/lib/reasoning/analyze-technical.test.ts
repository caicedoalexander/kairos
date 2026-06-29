import { describe, test, expect, vi } from 'vitest';
import { analyzeTechnical, type TaskSession } from './analyze-technical.ts';
import type { TechnicalRead } from './technical-read-schema.ts';

const READ: TechnicalRead = {
  bias: 'bullish', confluence: 'moderate', regime: 'trending',
  divergence: 'none', mtfNote: '4h y 15m alinean', notes: 'momentum sano',
};

function fakeSession(over: Partial<TaskSession> = {}): TaskSession {
  return {
    task: vi.fn(async () => ({ data: READ, usage: { totalTokens: 222 }, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } })),
    ...over,
  };
}

describe('analyzeTechnical', () => {
  test('delega a technical-analyst y mapea read/modelUsed/tokens', async () => {
    const s = fakeSession();
    const out = await analyzeTechnical(s, { symbol: 'BTC/USDT', snapshot: {} }, 'anthropic/claude-haiku-4-5');
    expect(out.read).toEqual(READ);
    expect(out.modelUsed).toBe('anthropic/claude-haiku-4-5');
    expect(out.tokens).toBe(222);
    expect(s.task).toHaveBeenCalledWith(
      expect.stringContaining('BTC/USDT'),
      // result: debe ir siempre — fuerza la salida estructurada Valibot (no degradar el contrato).
      expect.objectContaining({ agent: 'technical-analyst', model: 'anthropic/claude-haiku-4-5', result: expect.anything() }),
    );
  });

  test('propaga el error del task (la degradación la maneja el llamador)', async () => {
    const s = fakeSession({ task: async () => { throw new Error('haiku caído'); } });
    await expect(analyzeTechnical(s, { symbol: 'X' })).rejects.toThrow('haiku caído');
  });

  test('tokens null cuando usage no trae totalTokens', async () => {
    const s = fakeSession({ task: async () => ({ data: READ, usage: {}, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } }) });
    const out = await analyzeTechnical(s, { symbol: 'X' });
    expect(out.tokens).toBeNull();
  });
});
