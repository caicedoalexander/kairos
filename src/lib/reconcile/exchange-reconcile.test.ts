import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/orders.ts', () => ({
  findUnresolvedEntries: vi.fn(), updateOrderStatus: vi.fn(), setOrderExchangeId: vi.fn(), insertBracketLeg: vi.fn(),
  getBracketLegs: vi.fn(), closeBracketLegs: vi.fn(),
}));
vi.mock('../../db/repositories/positions.ts', () => ({
  openPosition: vi.fn(), setPositionProtected: vi.fn(),
  findUnprotectedPositions: vi.fn(), closeOpenPosition: vi.fn(),
}));
vi.mock('../../db/repositories/fills.ts', () => ({ insertFill: vi.fn(), getFillsForOrder: vi.fn(async () => []) }));
vi.mock('../../db/repositories/decisions.ts', () => ({ getDecisionVerdict: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));
vi.mock('../execution/real-order/order-state.ts', () => ({ fetchEntryState: vi.fn(), fetchExitFromTrades: vi.fn(), fetchLegState: vi.fn() }));

import { findUnresolvedEntries, updateOrderStatus, setOrderExchangeId, insertBracketLeg } from '../../db/repositories/orders.ts';
import { getBracketLegs, closeBracketLegs } from '../../db/repositories/orders.ts';
import { openPosition, setPositionProtected } from '../../db/repositories/positions.ts';
import { findUnprotectedPositions, closeOpenPosition } from '../../db/repositories/positions.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getDecisionVerdict } from '../../db/repositories/decisions.ts';
import { fetchEntryState, fetchExitFromTrades, fetchLegState } from '../execution/real-order/order-state.ts';
import { reconcileUnresolvedEntries, reconcileUnprotectedPositions, runExchangeReconcile } from './exchange-reconcile.ts';

const baseEntry = { id: 'o1', idempotencyKey: 'sig-1', decisionId: 'd1', symbol: 'BTC/USDT', strategyId: 'strat-1' };
function deps(over: Record<string, unknown> = {}) {
  return { client: {} as never, placeOco: vi.fn(async () => ({ orderListId: 'L1', slOrderId: 'SL', tpOrderId: 'TP' })),
    emergencyClose: vi.fn(), mode: 'testnet' as const, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDecisionVerdict).mockResolvedValue({ sl: 95, tp: 110 } as never);
  vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 100, exitFee: 0.05, qty: 0.5 });
});

describe('reconcileUnresolvedEntries', () => {
  it('entrada LLENADA → abre posición + fill + exchangeId real + re-protege + orden filled', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry]);
    vi.mocked(fetchEntryState).mockResolvedValue({ found: true, status: 'closed', filled: 0.5, average: 100, exchangeOrderId: 'BIN-1' });
    vi.mocked(openPosition).mockResolvedValue('p1');
    const d = deps();
    const r = await reconcileUnresolvedEntries(d);
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/USDT', size: 0.5, protected: false }));
    expect(insertFill).toHaveBeenCalled();
    expect(setOrderExchangeId).toHaveBeenCalledWith('o1', 'BIN-1');   // FIX M-2: id real, no el clientOrderId
    expect(d.placeOco).toHaveBeenCalledWith(d.client, expect.objectContaining({ symbol: 'BTC/USDT', qty: 0.5 }));
    expect(setPositionProtected).toHaveBeenCalledWith('p1', true);
    expect(updateOrderStatus).toHaveBeenCalledWith('o1', 'filled');
    expect(r.resolved).toBe(1);
  });

  it('entrada NO LLENADA (found:false) → orden canceled, sin posición', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry]);
    vi.mocked(fetchEntryState).mockResolvedValue({ found: false });
    await reconcileUnresolvedEntries(deps());
    expect(updateOrderStatus).toHaveBeenCalledWith('o1', 'canceled');
    expect(openPosition).not.toHaveBeenCalled();
  });

  it('found pero filled=0 → canceled (no abre posición size 0)', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry]);
    vi.mocked(fetchEntryState).mockResolvedValue({ found: true, status: 'canceled', filled: 0, average: 0, exchangeOrderId: '' });
    await reconcileUnresolvedEntries(deps());
    expect(updateOrderStatus).toHaveBeenCalledWith('o1', 'canceled');
    expect(openPosition).not.toHaveBeenCalled();
  });

  it('best-effort por ítem: un fallo audita y sigue con el siguiente', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([baseEntry, { ...baseEntry, id: 'o2', idempotencyKey: 'sig-2', decisionId: 'd2' }]);
    vi.mocked(fetchEntryState).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ found: false });
    const r = await reconcileUnresolvedEntries(deps());
    expect(updateOrderStatus).toHaveBeenCalledWith('o2', 'canceled'); // el segundo se procesó pese al fallo del primero
    expect(r.resolved).toBe(1);
  });
});

const basePos = { id: 'p1', symbol: 'BTC/USDT', strategyId: 'strat-1', decisionId: 'd1', entry: 100, size: 0.5, sl: 95, tp: 110, entryFee: 0.05 };

describe('reconcileUnprotectedPositions', () => {
  it('posición abierta + OCO vivo en el exchange → solo protected=true', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([
      { id: 'sl', purpose: 'sl', exchangeOrderId: 'X-SL', status: 'pending' },
      { id: 'tp', purpose: 'tp', exchangeOrderId: 'X-TP', status: 'pending' },
    ]);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'open', filled: 0 });
    await reconcileUnprotectedPositions(deps());
    expect(setPositionProtected).toHaveBeenCalledWith('p1', true);
    expect(closeOpenPosition).not.toHaveBeenCalled();
  });

  it('posición cerrada en el exchange (una leg llena) → cierra DB con P&L real', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([
      { id: 'sl', purpose: 'sl', exchangeOrderId: 'X-SL', status: 'pending' },
      { id: 'tp', purpose: 'tp', exchangeOrderId: 'X-TP', status: 'pending' },
    ]);
    vi.mocked(fetchLegState).mockImplementation(async (_c, _s, legId) =>
      legId === 'X-TP' ? { status: 'closed', filled: 0.5 } : { status: 'canceled', filled: 0 });
    vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 110, exitFee: 0.06, qty: 0.5 });
    vi.mocked(closeOpenPosition).mockResolvedValue(true);
    await reconcileUnprotectedPositions(deps());
    // realizedPnl = (110-100)*0.5 - 0.06 - 0.05 = 4.89
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(4.89, 6), expect.any(Date));
    expect(closeBracketLegs).toHaveBeenCalledWith('d1', 'tp');
  });

  it('posición abierta SIN OCO vivo → re-protege (placeOco) y protected=true', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([]); // sin legs persistidas
    const d = deps();
    await reconcileUnprotectedPositions(d);
    expect(d.placeOco).toHaveBeenCalledWith(d.client, expect.objectContaining({ symbol: 'BTC/USDT', qty: 0.5, sl: 95, tp: 110 }));
    expect(setPositionProtected).toHaveBeenCalledWith('p1', true);
  });

  it('re-protege actualizando las legs EN SITIO (no inserta duplicados) cuando ya existen', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    // 2 legs existentes (viejas, exchangeOrderId no-null) — reconcileOnePosition las filtra y pasa
    vi.mocked(getBracketLegs).mockResolvedValue([
      { id: 'sl-row', purpose: 'sl', exchangeOrderId: 'OLD-SL', status: 'canceled' },
      { id: 'tp-row', purpose: 'tp', exchangeOrderId: 'OLD-TP', status: 'canceled' },
    ]);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'canceled', filled: 0 }); // OCO muerto → reprotege
    const d = deps();
    await reconcileUnprotectedPositions(d);
    expect(d.placeOco).toHaveBeenCalled();
    expect(setOrderExchangeId).toHaveBeenCalledWith('sl-row', 'SL');  // del oco mock {slOrderId:'SL', tpOrderId:'TP'}
    expect(setOrderExchangeId).toHaveBeenCalledWith('tp-row', 'TP');
    expect(insertBracketLeg).not.toHaveBeenCalled(); // NO inserta duplicados
    expect(setPositionProtected).toHaveBeenCalledWith('p1', true);
  });

  it('re-protección falla → cierre de emergencia + cierra DB con P&L real', async () => {
    vi.mocked(findUnprotectedPositions).mockResolvedValue([basePos]);
    vi.mocked(getBracketLegs).mockResolvedValue([]);
    vi.mocked(closeOpenPosition).mockResolvedValue(true);
    const d = deps({ placeOco: vi.fn(async () => { throw new Error('oco down'); }),
      emergencyClose: vi.fn(async () => ({ exitPrice: 96, exitFee: 0.05, exchangeOrderId: 'EM' })) });
    await reconcileUnprotectedPositions(d);
    expect(d.emergencyClose).toHaveBeenCalled();
    // realizedPnl = (96-100)*0.5 - 0.05 - 0.05 = -2.10
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(-2.10, 6), expect.any(Date));
  });
});

describe('runExchangeReconcile', () => {
  it('corre A.1 y A.2 y devuelve los conteos', async () => {
    vi.mocked(findUnresolvedEntries).mockResolvedValue([]);
    vi.mocked(findUnprotectedPositions).mockResolvedValue([]);
    expect(await runExchangeReconcile(deps())).toEqual({ entries: 0, positions: 0 });
  });
});
