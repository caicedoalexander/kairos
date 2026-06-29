import { describe, test, expect, vi } from 'vitest';
import { analyzeFundamental, type FundamentalTaskSession } from './analyze-fundamental.ts';
import { FundamentalReadSchema, type FundamentalRead } from './fundamental-read-schema.ts';

const READ: FundamentalRead = {
  bias: 'bearish', catalysts: [{ title: 'hack', sentiment: 'bearish', relevance: 'high' }],
  positioning: 'crowded_long', decayNote: 'reciente', confidence: 'alta',
};

function fakeSession(over: Partial<FundamentalTaskSession> = {}): FundamentalTaskSession {
  return {
    task: vi.fn(async () => ({ data: READ, usage: { totalTokens: 333 }, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } })),
    ...over,
  };
}

describe('analyzeFundamental', () => {
  test('delega a fundamental-analyst con el schema exacto y mapea read/modelUsed/tokens', async () => {
    const s = fakeSession();
    const out = await analyzeFundamental(s, { symbol: 'BTC/USDT', news: [] }, 'anthropic/claude-haiku-4-5');
    expect(out.read).toEqual(READ);
    expect(out.modelUsed).toBe('anthropic/claude-haiku-4-5');
    expect(out.tokens).toBe(333);
    expect(s.task).toHaveBeenCalledWith(
      expect.stringContaining('BTC/USDT'),
      expect.objectContaining({ agent: 'fundamental-analyst', model: 'anthropic/claude-haiku-4-5', result: FundamentalReadSchema }),
    );
  });

  test('propaga el error del task (la degradación la maneja el llamador)', async () => {
    const s = fakeSession({ task: async () => { throw new Error('haiku caído'); } });
    await expect(analyzeFundamental(s, { symbol: 'X' })).rejects.toThrow('haiku caído');
  });

  test('tokens null cuando usage no trae totalTokens', async () => {
    const s = fakeSession({ task: async () => ({ data: READ, usage: {}, model: { provider: 'anthropic', id: 'claude-haiku-4-5' } }) });
    const out = await analyzeFundamental(s, { symbol: 'X' });
    expect(out.tokens).toBeNull();
  });
});
