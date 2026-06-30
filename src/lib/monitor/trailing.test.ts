import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../db/repositories/positions.ts', () => ({ getOpenPositionById: vi.fn(), setPositionSl: vi.fn(), setPositionProtected: vi.fn() }));
vi.mock('../../db/repositories/orders.ts', () => ({ getBracketLegs: vi.fn(), setOrderExchangeId: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));

import { computeTrailingSl, applyTrailingStop } from './trailing.ts';
import type { TrailingConfig } from './trailing-config.ts';
import { getOpenPositionById, setPositionSl, setPositionProtected } from '../../db/repositories/positions.ts';
import { getBracketLegs, setOrderExchangeId } from '../../db/repositories/orders.ts';

const cfg: TrailingConfig = { enabled: true, activation_pct: 0.01, distance_pct: 0.015, min_step_pct: 0.003 };

describe('computeTrailingSl', () => {
  it('no activa si el precio no superó entry*(1+activation)', () => {
    // entry 100, activación a 101; precio 100.5 < 101
    expect(computeTrailingSl({ entry: 100, currentSl: 95, price: 100.5, cfg })).toBeNull();
  });

  it('sube el SL cuando el candidato supera el SL vigente por min_step', () => {
    // precio 110 (>101), candidato = 110*(1-0.015) = 108.35; SL viejo 95 → sube
    expect(computeTrailingSl({ entry: 100, currentSl: 95, price: 110, cfg })).toBeCloseTo(108.35, 6);
  });

  it('NO baja: si el candidato < SL vigente → null', () => {
    // precio 110 → candidato 108.35; SL vigente 109 (> candidato) → null (nunca baja)
    expect(computeTrailingSl({ entry: 100, currentSl: 109, price: 110, cfg })).toBeNull();
  });

  it('NO se mueve por micro-paso (< min_step sobre el SL vigente)', () => {
    // candidato 108.35; SL vigente 108.2; 108.2*(1+0.003)=108.5246 > 108.35 → null (no supera min_step)
    expect(computeTrailingSl({ entry: 100, currentSl: 108.2, price: 110, cfg })).toBeNull();
  });

  it('el candidato siempre queda bajo el precio', () => {
    const sl = computeTrailingSl({ entry: 100, currentSl: 95, price: 110, cfg });
    expect(sl).not.toBeNull();
    expect(sl as number).toBeLessThan(110);
  });
});

const pos = { id: 'p1', symbol: 'BTC/USDT', strategyId: 's1', decisionId: 'd1', entry: 100, size: 0.5, sl: 95, tp: 110, entryFee: 0.05 };
const legs = [
  { id: 'sl-row', purpose: 'sl' as const, exchangeOrderId: 'OLD-SL', status: 'pending' },
  { id: 'tp-row', purpose: 'tp' as const, exchangeOrderId: 'OLD-TP', status: 'pending' },
];
const passthroughLock = async (_s: string, _y: string, _m: string, fn: () => Promise<void>) => fn();

function tdeps(over: Record<string, unknown> = {}) {
  return { client: {} as never, mode: 'testnet' as const, notify: vi.fn(async () => ({ messageId: 'm' })),
    cancelOco: vi.fn(async () => {}),
    placeOco: vi.fn(async () => ({ orderListId: 'L', slOrderId: 'NEW-SL', tpOrderId: 'NEW-TP' })),
    withLock: passthroughLock, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOpenPositionById).mockResolvedValue({ ...pos, protected: true });
  vi.mocked(getBracketLegs).mockResolvedValue(legs);
});

describe('applyTrailingStop', () => {
  it('happy: cancel → place(newSl) → setPositionSl DESPUÉS + legs en sitio; protected NO se baja', async () => {
    const d = tdeps();
    await applyTrailingStop(d as never, pos as never, 108);
    expect(d.cancelOco).toHaveBeenCalled();
    expect(d.placeOco).toHaveBeenCalledWith(d.client, { symbol: 'BTC/USDT', qty: 0.5, sl: 108, tp: 110 });
    // setPositionSl DESPUÉS de placeOco (invocationCallOrder)
    expect(vi.mocked(d.placeOco).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(setPositionSl).mock.invocationCallOrder[0]);
    expect(setPositionSl).toHaveBeenCalledWith('p1', 108);
    expect(setOrderExchangeId).toHaveBeenCalledWith('sl-row', 'NEW-SL');
    expect(setOrderExchangeId).toHaveBeenCalledWith('tp-row', 'NEW-TP');
    expect(setPositionProtected).not.toHaveBeenCalled(); // FIX H3: no se baja
  });

  it('placeOco(newSl) falla → fallback placeOco(oldSl); sl NO cambia; protected NO se baja', async () => {
    const placeOco = vi.fn()
      .mockRejectedValueOnce(new Error('would immediately trigger'))
      .mockResolvedValueOnce({ orderListId: 'L', slOrderId: 'OLD2-SL', tpOrderId: 'OLD2-TP' });
    const d = tdeps({ placeOco });
    await applyTrailingStop(d as never, pos as never, 108);
    expect(placeOco).toHaveBeenNthCalledWith(2, d.client, { symbol: 'BTC/USDT', qty: 0.5, sl: 95, tp: 110 }); // fallback al SL viejo
    expect(setPositionSl).not.toHaveBeenCalled();      // no persiste el candidato inválido
    expect(setPositionProtected).not.toHaveBeenCalled();
  });

  it('doble-fallo (newSl y oldSl) → setPositionProtected(false) → A.2', async () => {
    const placeOco = vi.fn().mockRejectedValue(new Error('down'));
    const d = tdeps({ placeOco });
    await applyTrailingStop(d as never, pos as never, 108);
    expect(setPositionProtected).toHaveBeenCalledWith('p1', false);
    expect(setPositionSl).not.toHaveBeenCalled();
  });

  it('cancelOco falla → aborta sin tocar protected ni placeOco', async () => {
    const d = tdeps({ cancelOco: vi.fn(async () => { throw new Error('net'); }) });
    await applyTrailingStop(d as never, pos as never, 108);
    expect(d.placeOco).not.toHaveBeenCalled();
    expect(setPositionProtected).not.toHaveBeenCalled();
    expect(setPositionSl).not.toHaveBeenCalled();
  });

  it('re-check: si dejó de estar protegida → no hace nada', async () => {
    vi.mocked(getOpenPositionById).mockResolvedValue({ ...pos, protected: false });
    const d = tdeps();
    await applyTrailingStop(d as never, pos as never, 108);
    expect(d.cancelOco).not.toHaveBeenCalled();
  });
});
