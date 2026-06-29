import { describe, test, expect, vi } from 'vitest';
import { runDecisionMaker, type DecisionMakerDeps } from './run-decision-maker.ts';
import type { Signal, Strategy } from '../scanner/types.ts';
import type { LlmVerdict } from './verdict-schema.ts';
import type { TechnicalRead } from './technical-read-schema.ts';
import type { FundamentalRead } from './fundamental-read-schema.ts';
import type { NewsItem } from '../sources/cryptopanic.ts';
const READ: TechnicalRead = { bias: 'bullish', confluence: 'strong', regime: 'trending', divergence: 'none', mtfNote: 'm', notes: 'n' };
const FREAD: FundamentalRead = { bias: 'bearish', catalysts: [{ title: 'hack', sentiment: 'bearish', relevance: 'high' }], positioning: 'crowded_long', decayNote: 'reciente', confidence: 'alta' };
const NEWS_ITEM: NewsItem = { title: 'hack', publishedAt: '2026-06-28T11:00:00Z', kind: 'news', url: 'u' };

const SIGNAL: Signal = { strategyId: 's1', symbol: 'BTC/USDT', firedAt: new Date('2026-03-21T00:00:00Z'), snapshot: { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ: null, oiChangePct: null } } };
const STRATEGY: Strategy = { id: 's1', enabled: true, symbols: ['BTC/USDT'], triggerConfig: { timeframes: { bias: '4h', context: '1h', trigger: '15m' }, entry: { all: [] } }, riskParams: { atr_stop_mult: 1.5 }, version: 1, skillName: null };
const VERDICT: LlmVerdict = { action: 'enter', entry: 100, sl: 97, tp: 106, sizingFactor: 1, confianza: 'media', razonamiento: 'x' };

function deps(over: Partial<DecisionMakerDeps> = {}): DecisionMakerDeps {
  return {
    getSignal: async () => SIGNAL,
    getStrategy: async () => STRATEGY,
    isAlreadyEvaluated: async () => false,
    analyze: async () => ({ read: READ, modelUsed: 'anthropic/claude-haiku-4-5', tokens: 50 }),
    isMajorCap: () => true,
    fetchNews: async () => ({ items: [NEWS_ITEM], ok: true }),
    shouldRunFundamental: () => true,
    analyzeFundamental: async () => ({ read: FREAD, modelUsed: 'anthropic/claude-haiku-4-5', tokens: 222 }),
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

  test('camino feliz: persiste verdict + technical_read/model/tokens', async () => {
    const d = deps();
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({
      technicalRead: READ, technicalModel: 'anthropic/claude-haiku-4-5', technicalTokens: 50,
    }));
  });

  test('el technical_read viaja en los args de evaluate (clave snake_case)', async () => {
    const evaluate = vi.fn(async () => ({ verdict: VERDICT, modelUsed: 'm', tokens: 1 }));
    await runDecisionMaker('sig1', deps({ evaluate }));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ technical_read: READ }));
  });

  test('degradación: analista falla → technical_read null + audit, veredicto se emite igual', async () => {
    const d = deps({ analyze: async () => { throw new Error('haiku caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'technical_read_failed',
      payload: expect.objectContaining({ error: 'haiku caído', errorType: 'Error' }),
    }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ technicalRead: null, technicalModel: null, technicalTokens: null }));
  });

  test('R3: si evaluate falla tras analyze exitoso, shadow_failed lleva el read y tokens', async () => {
    const d = deps({ evaluate: async () => { throw new Error('sonnet caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('failed');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'shadow_failed',
      payload: expect.objectContaining({ technicalRead: READ, technicalTokens: 50, technicalModel: 'anthropic/claude-haiku-4-5' }),
    }));
  });

  test('major-cap con catalizador → corre el fundamental y persiste read/status=ran/fetch_ok=true', async () => {
    const d = deps();
    await runDecisionMaker('sig1', d);
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({
      fundamentalRead: FREAD, fundamentalModel: 'anthropic/claude-haiku-4-5', fundamentalTokens: 222,
      fundamentalStatus: 'ran', fundamentalFetchOk: true,
    }));
  });

  test('el fundamental_read viaja en los args de evaluate (clave snake_case)', async () => {
    const evaluate = vi.fn(async () => ({ verdict: VERDICT, modelUsed: 'm', tokens: 1 }));
    await runDecisionMaker('sig1', deps({ evaluate }));
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ fundamental_read: FREAD }));
  });

  test('no major-cap → skipped_not_major, sin fetch ni LLM', async () => {
    const fetchNews = vi.fn(async () => ({ items: [], ok: true }));
    const analyzeFundamental = vi.fn();
    const d = deps({ isMajorCap: () => false, fetchNews, analyzeFundamental });
    await runDecisionMaker('sig1', d);
    expect(fetchNews).not.toHaveBeenCalled();
    expect(analyzeFundamental).not.toHaveBeenCalled();
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'skipped_not_major', fundamentalRead: null, fundamentalFetchOk: null }));
  });

  test('gate false con fetch ok → skipped_quiet', async () => {
    const d = deps({ shouldRunFundamental: () => false });
    await runDecisionMaker('sig1', d);
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'skipped_quiet', fundamentalFetchOk: true }));
  });

  test('gate false con fetch fallido → skipped_fetch_failed + audit', async () => {
    const d = deps({ fetchNews: async () => ({ items: [], ok: false }), shouldRunFundamental: () => false });
    await runDecisionMaker('sig1', d);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'fundamental_fetch_failed' }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'skipped_fetch_failed', fundamentalFetchOk: false }));
  });

  test('analista fundamental falla → status=failed + audit, veredicto se emite igual', async () => {
    const d = deps({ analyzeFundamental: async () => { throw new Error('haiku caído'); } });
    const r = await runDecisionMaker('sig1', d);
    expect(r.kind).toBe('persisted');
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'fundamental_read_failed' }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({ fundamentalStatus: 'failed', fundamentalRead: null }));
  });

  test('ran degradado: fetch falló pero derivados extremos → ran + fetch_ok=false (HIGH-1)', async () => {
    // El gate pasa por derivados extremos aunque el fetch de noticias falle: el analista corre con
    // news=[], status='ran' pero fetchOk=false → el A/B (SP10) distingue un 'ran' degradado.
    const d = deps({ fetchNews: async () => ({ items: [], ok: false }), shouldRunFundamental: () => true });
    await runDecisionMaker('sig1', d);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'fundamental_fetch_failed' }));
    expect(d.persist).toHaveBeenCalledWith(expect.objectContaining({
      fundamentalStatus: 'ran', fundamentalFetchOk: false, fundamentalRead: FREAD,
    }));
  });
});
