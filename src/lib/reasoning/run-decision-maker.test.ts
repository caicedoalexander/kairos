import { describe, test, expect, vi } from 'vitest';
import { runDecisionMaker, type DecisionMakerDeps } from './run-decision-maker.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';

const SIGNAL: Signal = { strategyId: 's1', symbol: 'BTC/USDT', firedAt: new Date('2026-03-21T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
const STRATEGY: Strategy = { id: 's1', enabled: true, symbols: ['BTC/USDT'], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: { atr_stop_mult: 1.5 }, version: 1, skillName: null };
const VERDICT: LlmVerdict = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' };

function deps(over: Partial<DecisionMakerDeps> = {}): DecisionMakerDeps {
  return {
    getSignal: async () => SIGNAL,
    getStrategy: async () => STRATEGY,
    isAlreadyEvaluated: async () => false,
    evaluate: async () => ({ verdict: VERDICT, modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 99 }),
    persist: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    ...over,
  };
}

describe('runDecisionMaker', () => {
  test('camino feliz → persisted y persiste el row', async () => {
    const d = deps();
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ signalId: 'sig1', modelUsed: 'anthropic/claude-sonnet-4-6', tokens: 99, confianza: 'media' }));
    expect(d.audit).not.toHaveBeenCalled(); // camino feliz no audita
  });

  test('señal inexistente → not_found, no evalúa', async () => {
    const d = deps({ getSignal: async () => null, evaluate: vi.fn() });
    const r = await runDecisionMaker('x', d);
    expect(r.kind).toBe('not_found');
    expect(d.evaluate).not.toHaveBeenCalled();
  });

  test('estrategia inexistente → not_found, no evalúa', async () => {
    const d = deps({ getStrategy: async () => null, evaluate: vi.fn() });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('not_found');
    expect(d.evaluate).not.toHaveBeenCalled();
  });

  test('ya evaluada → duplicate, no evalúa ni persiste', async () => {
    const d = deps({ isAlreadyEvaluated: async () => true, evaluate: vi.fn(), persist: vi.fn(), getStrategy: vi.fn() });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('duplicate');
    expect(d.evaluate).not.toHaveBeenCalled();
    expect(d.persist).not.toHaveBeenCalled();
    expect(d.getStrategy).not.toHaveBeenCalled();
  });

  test('fallo del modelo → failed + audita shadow_failed, NO lanza', async () => {
    const d = deps({ evaluate: async () => { throw new Error('modelo caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('failed');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'shadow_failed' }));
  });

  test('fallo de persist propaga (no se traga como shadow_failed)', async () => {
    const d = deps({ persist: async () => { throw new Error('DB caída'); } });
    await expect(runDecisionMaker('sig1', d)).rejects.toThrow('DB caída');
    expect(d.audit).not.toHaveBeenCalled(); // no se mal-etiqueta como shadow_failed
  });
});
