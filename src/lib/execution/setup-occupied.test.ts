import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repositories/positions.ts', () => ({ hasOpenPositionForSetup: vi.fn() }));
vi.mock('../../db/repositories/orders.ts', () => ({ hasUnresolvedEntryForSetup: vi.fn() }));

import { hasOpenPositionForSetup } from '../../db/repositories/positions.ts';
import { hasUnresolvedEntryForSetup } from '../../db/repositories/orders.ts';
import { isSetupOccupied } from './setup-occupied.ts';

beforeEach(() => { vi.clearAllMocks(); });

describe('isSetupOccupied', () => {
  it('true si hay posición abierta (corta-circuito, no consulta órdenes)', async () => {
    vi.mocked(hasOpenPositionForSetup).mockResolvedValue(true);
    expect(await isSetupOccupied('s', 'BTC/USDT', 'testnet')).toBe(true);
    expect(hasUnresolvedEntryForSetup).not.toHaveBeenCalled();
  });

  it('true si hay entrada sin resolver (aunque no haya posición)', async () => {
    vi.mocked(hasOpenPositionForSetup).mockResolvedValue(false);
    vi.mocked(hasUnresolvedEntryForSetup).mockResolvedValue(true);
    expect(await isSetupOccupied('s', 'BTC/USDT', 'testnet')).toBe(true);
  });

  it('false si no hay ni posición ni entrada sin resolver', async () => {
    vi.mocked(hasOpenPositionForSetup).mockResolvedValue(false);
    vi.mocked(hasUnresolvedEntryForSetup).mockResolvedValue(false);
    expect(await isSetupOccupied('s', 'BTC/USDT', 'testnet')).toBe(false);
  });
});
