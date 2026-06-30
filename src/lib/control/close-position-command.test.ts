import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/positions.ts', () => ({ getOpenPositionBySymbol: vi.fn(), closeOpenPosition: vi.fn(), setPositionProtected: vi.fn() }));
vi.mock('../../db/repositories/orders.ts', () => ({ getBracketLegs: vi.fn(), closeBracketLegs: vi.fn() }));
vi.mock('../../db/repositories/fills.ts', () => ({ insertFill: vi.fn() }));
vi.mock('../../db/repositories/ohlcv-candles.ts', () => ({ getLatestClosePrice: vi.fn() }));
vi.mock('../../db/repositories/audit-log.ts', () => ({ appendAuditLog: vi.fn() }));

import { getOpenPositionBySymbol, closeOpenPosition, setPositionProtected } from '../../db/repositories/positions.ts';
import { getBracketLegs, closeBracketLegs } from '../../db/repositories/orders.ts';
import { insertFill } from '../../db/repositories/fills.ts';
import { getLatestClosePrice } from '../../db/repositories/ohlcv-candles.ts';
import { closePositionCommand } from './close-position-command.ts';

const pos = { id: 'p1', symbol: 'BTC/USDT', strategyId: 's1', decisionId: 'd1', entry: 100, size: 0.5, sl: 95, tp: 110, entryFee: 0.05 };
const legs = [{ id: 'sl-row', purpose: 'sl' as const, exchangeOrderId: 'X-SL', status: 'pending' }];
// withLock que ejecuta fn directamente (sin Redis).
const passthroughLock = async (_s: string, _y: string, _m: string, fn: () => Promise<string>) => fn();

function realDeps(over: Record<string, unknown> = {}) {
  return { mode: 'testnet' as const, client: {} as never, cancelOco: vi.fn(async () => {}),
    emergencyClose: vi.fn(async () => ({ exitPrice: 110, exitFee: 0.06, exchangeOrderId: 'EX' })),
    withLock: passthroughLock, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBracketLegs).mockResolvedValue(legs);
  vi.mocked(closeOpenPosition).mockResolvedValue(true);
});

describe('closePositionCommand — testnet', () => {
  it('cancel-first → market sell → cierra con P&L real', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    const d = realDeps();
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(d.cancelOco).toHaveBeenCalledWith(d.client, 'BTC/USDT', legs);          // cancel-first
    expect(d.emergencyClose).toHaveBeenCalledWith(d.client, { symbol: 'BTC/USDT', qty: 0.5 });
    // fill de salida contra la leg (FK válida); en real recordClose recibe legs[0].id
    expect(insertFill).toHaveBeenCalledWith({ orderId: 'sl-row', price: 110, qty: 0.5, fee: 0.06 });
    // realized = (110-100)*0.5 - 0.06 - 0.05 = 4.89
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(4.89, 6), expect.any(Date));
    expect(closeBracketLegs).toHaveBeenCalledWith('d1', 'sl');
    expect(reply).toContain('cerrada');
  });

  it('sin posición → mensaje, no toca el exchange', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(null);
    const d = realDeps();
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(d.cancelOco).not.toHaveBeenCalled();
    expect(reply).toContain('no hay posición abierta');
  });

  it('cancelOco falla (red) → aborta SIN tocar protected (OCO sigue vivo)', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    const d = realDeps({ cancelOco: vi.fn(async () => { throw new Error('net'); }) });
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(setPositionProtected).not.toHaveBeenCalled();
    expect(closeOpenPosition).not.toHaveBeenCalled();
    expect(reply).toMatch(/no se pudo cancelar|reintenta/i);
  });

  it('emergencyClose falla tras cancelar → setPositionProtected(false) (FIX H2) + reconciliación', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    const d = realDeps({ emergencyClose: vi.fn(async () => { throw new Error('InsufficientFunds'); }) });
    const reply = await closePositionCommand('BTC/USDT', d);
    expect(setPositionProtected).toHaveBeenCalledWith('p1', false);
    expect(closeOpenPosition).not.toHaveBeenCalled();
    expect(reply).toMatch(/reconciliación|reintenta/i);
  });

  it('insertFill lanza → closeOpenPosition se llama igual (fill es best-effort)', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    vi.mocked(insertFill).mockRejectedValue(new Error('FK inválida'));
    const d = realDeps();
    const reply = await closePositionCommand('BTC/USDT', d);
    // El fill falló pero el cierre canónico no se bloqueó
    expect(closeOpenPosition).toHaveBeenCalledWith('p1', expect.closeTo(4.89, 6), expect.any(Date));
    expect(reply).toContain('cerrada');
  });
});

describe('closePositionCommand — sim', () => {
  it('cierra sintético al último precio con sim fill', async () => {
    vi.mocked(getOpenPositionBySymbol).mockResolvedValue(pos);
    vi.mocked(getLatestClosePrice).mockResolvedValue(108);
    const d = { mode: 'sim' as const, cancelOco: vi.fn(), emergencyClose: vi.fn(), withLock: passthroughLock };
    const reply = await closePositionCommand('BTC/USDT', d as never);
    expect(d.cancelOco).not.toHaveBeenCalled();
    expect(d.emergencyClose).not.toHaveBeenCalled();
    expect(closeOpenPosition).toHaveBeenCalled();   // cierra con P&L sintético (el fill se omite en sim — sin leg id)
    expect(reply).toContain('sim');
  });
});
