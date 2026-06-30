import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/orders.ts', () => ({
  findUnresolvedEntries: vi.fn(), updateOrderStatus: vi.fn(), setOrderExchangeId: vi.fn(), insertBracketLeg: vi.fn(),
}));
vi.mock('../../db/repositories/positions.ts', () => ({ openPosition: vi.fn(), setPositionProtected: vi.fn() }));
vi.mock('../../db/repositories/fills.ts', () => ({ insertFill: vi.fn(), getFillsForOrder: vi.fn(async () => []) }));
vi.mock('../../db/repositories/decisions.ts', () => ({ getDecisionVerdict: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));
vi.mock('../execution/real-order/order-state.ts', () => ({ fetchEntryState: vi.fn(), fetchExitFromTrades: vi.fn() }));

import { findUnresolvedEntries, updateOrderStatus, setOrderExchangeId } from '../../db/repositories/orders.ts';
import { openPosition, setPositionProtected } from '../../db/repositories/positions.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getDecisionVerdict } from '../../db/repositories/decisions.ts';
import { fetchEntryState, fetchExitFromTrades } from '../execution/real-order/order-state.ts';
import { reconcileUnresolvedEntries } from './exchange-reconcile.ts';

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
