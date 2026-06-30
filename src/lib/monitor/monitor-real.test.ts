import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/positions.ts', () => ({ getProtectedOpenPositions: vi.fn(), setPositionProtected: vi.fn(), closeOpenPosition: vi.fn() }));
vi.mock('../../db/repositories/orders.ts', () => ({ getBracketLegs: vi.fn(), closeBracketLegs: vi.fn() }));
vi.mock('../../db/repositories/fills.ts', () => ({ insertFill: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));
vi.mock('../execution/real-order/order-state.ts', () => ({ fetchLegState: vi.fn(), fetchExitFromTrades: vi.fn() }));
vi.mock('../../db/repositories/strategies.ts', () => ({ getStrategy: vi.fn() }));
vi.mock('./trailing.ts', () => ({ computeTrailingSl: vi.fn(), applyTrailingStop: vi.fn() }));
vi.mock('./trailing-config.ts', () => ({ parseTrailingConfig: vi.fn() }));

import { getProtectedOpenPositions, setPositionProtected, closeOpenPosition } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { fetchLegState, fetchExitFromTrades } from '../execution/real-order/order-state.ts';
import { getStrategy } from '../../db/repositories/strategies.ts';
import { computeTrailingSl, applyTrailingStop } from './trailing.ts';
import { parseTrailingConfig } from './trailing-config.ts';
import { runMonitorTickReal } from './monitor-real.ts';

const pos = { id: 'p1', symbol: 'BTC/USDT', strategyId: 's', decisionId: 'd1', entry: 100, size: 0.5, sl: 95, tp: 110, entryFee: 0.05 };
const baseClient = {} as Record<string, unknown>;
function deps() { return { client: {} as never, mode: 'testnet' as const, notify: vi.fn(async () => ({ messageId: 'm' })) }; }
const legs = [
  { id: 'sl', purpose: 'sl' as const, exchangeOrderId: 'X-SL', status: 'pending' },
  { id: 'tp', purpose: 'tp' as const, exchangeOrderId: 'X-TP', status: 'pending' },
];

beforeEach(() => { vi.clearAllMocks(); vi.mocked(getBracketLegs).mockResolvedValue(legs); });

describe('runMonitorTickReal', () => {
  it('leg TP llena → close-first → fill + closeBracketLegs + notify', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockImplementation(async (_c, _s, id) => id === 'X-TP' ? { status: 'closed', filled: 0.5 } : { status: 'canceled', filled: 0 });
    vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 110, exitFee: 0.06, qty: 0.5 });
    vi.mocked(closeOpenPosition).mockResolvedValue(true);
    const r = await runMonitorTickReal(new Date(), deps());
    // close-first: closeOpenPosition ANTES de insertFill
    expect(vi.mocked(closeOpenPosition).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(insertFill).mock.invocationCallOrder[0]);
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(4.89, 6), expect.any(Date));
    expect(closeBracketLegs).toHaveBeenCalledWith('d1', 'tp');
    expect(r.closed).toBe(1);
  });

  it('close-first idempotente: si closeOpenPosition devuelve false (otro tick ya cerró) → NO inserta fill', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockImplementation(async (_c, _s, id) => id === 'X-TP' ? { status: 'closed', filled: 0.5 } : { status: 'canceled', filled: 0 });
    vi.mocked(fetchExitFromTrades).mockResolvedValue({ exitPrice: 110, exitFee: 0.06, qty: 0.5 });
    vi.mocked(closeOpenPosition).mockResolvedValue(false);
    const r = await runMonitorTickReal(new Date(), deps());
    expect(insertFill).not.toHaveBeenCalled();
    expect(r.closed).toBe(0);
  });

  it('ambas legs terminales sin fill → handoff M3 (protected=false), no cierra', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'canceled', filled: 0 });
    await runMonitorTickReal(new Date(), deps());
    expect(setPositionProtected).toHaveBeenCalledWith('p1', false);
    expect(closeOpenPosition).not.toHaveBeenCalled();
  });

  it('ambas legs abiertas → nada', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'open', filled: 0 });
    const r = await runMonitorTickReal(new Date(), deps());
    expect(setPositionProtected).not.toHaveBeenCalled();
    expect(closeOpenPosition).not.toHaveBeenCalled();
    expect(r.closed).toBe(0);
  });

  it('best-effort: un fallo de posición audita y el tick sigue', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos, { ...pos, id: 'p2', decisionId: 'd2' }]);
    vi.mocked(fetchLegState).mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ status: 'open', filled: 0 });
    const r = await runMonitorTickReal(new Date(), deps());
    expect(r.checked).toBe(2); // ambas chequeadas pese al fallo
  });

  it('OCO vivo + estrategia con trailing → evalúa y aplica trailing', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(getBracketLegs).mockResolvedValue(legs);                 // 2 legs vivas
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'open', filled: 0 }); // OCO vivo
    vi.mocked(getStrategy).mockResolvedValue({ riskParams: { trailing: {} } } as never);
    vi.mocked(parseTrailingConfig).mockReturnValue({ enabled: true, activation_pct: 0.01, distance_pct: 0.015, min_step_pct: 0.003 });
    vi.mocked(computeTrailingSl).mockReturnValue(108);
    const client = { ...baseClient, fetchTicker: vi.fn(async () => ({ last: 110 })) };
    await runMonitorTickReal(new Date(), { client, mode: 'testnet', notify: vi.fn(async () => ({ messageId: 'm' })) } as never);
    expect(applyTrailingStop).toHaveBeenCalled();
  });

  it('OCO vivo + estrategia SIN trailing → no aplica trailing', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(getBracketLegs).mockResolvedValue(legs);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'open', filled: 0 });
    vi.mocked(getStrategy).mockResolvedValue({ riskParams: {} } as never);
    vi.mocked(parseTrailingConfig).mockReturnValue(null);
    await runMonitorTickReal(new Date(), { client: { ...baseClient, fetchTicker: vi.fn() }, mode: 'testnet', notify: vi.fn() } as never);
    expect(applyTrailingStop).not.toHaveBeenCalled();
  });

  it('el cierre por fill tiene PRIORIDAD: si una leg llenó, NO hace trailing', async () => {
    vi.mocked(getProtectedOpenPositions).mockResolvedValue([pos]);
    vi.mocked(getBracketLegs).mockResolvedValue(legs);
    vi.mocked(fetchLegState).mockResolvedValue({ status: 'closed', filled: 0.5 }); // leg llena → cierra
    vi.mocked(closeOpenPosition).mockResolvedValue(true);
    await runMonitorTickReal(new Date(), { client: { ...baseClient, fetchTicker: vi.fn() }, mode: 'testnet', notify: vi.fn(async () => ({ messageId: 'm' })) } as never);
    expect(applyTrailingStop).not.toHaveBeenCalled();
  });
});
