import { describe, test, expect } from 'vitest';
import { emptyLedger, markToMarket, markEquity, applyOpen, applyClose, gatherState } from './accounting.ts';
import type { OpenPosition } from './types.ts';

const POS: OpenPosition = { entry: 100, size: 2, sl: 95, tp: 110, entryFee: 0.2, openedAt: new Date('2024-01-01T00:00:00Z') };

describe('accounting', () => {
  test('emptyLedger arranca plano', () => {
    const l = emptyLedger(10000);
    expect(l.realized).toBe(0);
    expect(l.peakEquity).toBe(10000);
    expect(l.open).toBeNull();
  });

  test('markToMarket suma el no-realizado de la posición abierta (sin fee de salida)', () => {
    const l = applyOpen(emptyLedger(10000), POS);
    // unrealized = (105-100)*2 - 0.2 = 9.8
    expect(markToMarket(l, 105)).toBeCloseTo(10009.8, 6);
  });

  test('markEquity sube el high-water mark, nunca baja', () => {
    let l = applyOpen(emptyLedger(10000), POS);
    l = markEquity(l, 105);          // mtm 10009.8 → peak sube
    expect(l.peakEquity).toBeCloseTo(10009.8, 6);
    l = markEquity(l, 90);           // mtm baja → peak NO baja
    expect(l.peakEquity).toBeCloseTo(10009.8, 6);
  });

  test('applyClose registra el trade, acumula realized y deja open en null', () => {
    let l = applyOpen(emptyLedger(10000), POS);
    l = applyClose(l, { hitType: 'tp', exitPrice: 110, exitFee: 0.22, realizedPnl: 19.58 }, POS.openedAt, new Date('2024-01-01T05:00:00Z'));
    expect(l.open).toBeNull();
    expect(l.realized).toBeCloseTo(19.58, 6);
    expect(l.trades).toHaveLength(1);
    // rMultiple = realizedPnl / ((entry - sl) * size) = 19.58 / ((100-95)*2) = 1.958
    expect(l.trades[0].rMultiple).toBeCloseTo(1.958, 3);
    expect(l.trades[0].fees).toBeCloseTo(0.42, 6); // entryFee + exitFee
  });

  test('gatherState: dailyPnl solo del día UTC de T, racha de pérdidas, exposición', () => {
    let l = emptyLedger(10000);
    // cierre perdedor el 2024-01-01
    l = applyClose(applyOpen(l, POS), { hitType: 'sl', exitPrice: 95, exitFee: 0.2, realizedPnl: -10.4 }, POS.openedAt, new Date('2024-01-01T03:00:00Z'));
    // cierre perdedor el 2024-01-02
    l = applyClose(applyOpen(l, { ...POS, openedAt: new Date('2024-01-02T00:00:00Z') }), { hitType: 'sl', exitPrice: 95, exitFee: 0.2, realizedPnl: -10.4 }, new Date('2024-01-02T00:00:00Z'), new Date('2024-01-02T03:00:00Z'));
    const s = gatherState(l, new Date('2024-01-02T10:00:00Z'), 100);
    expect(s.dailyPnl).toBeCloseTo(-10.4, 6);     // solo el cierre del 02
    expect(s.consecutiveLosses).toBe(2);          // ambos perdedores, consecutivos
    expect(s.openPositionsCount).toBe(0);
  });

  test('gatherState: el cierre de ayer UTC se excluye del dailyPnl (borde de día)', () => {
    let l = applyClose(applyOpen(emptyLedger(10000), POS), { hitType: 'tp', exitPrice: 110, exitFee: 0.2, realizedPnl: 19.6 }, POS.openedAt, new Date('2024-01-01T23:59:59Z'));
    const s = gatherState(l, new Date('2024-01-02T00:00:01Z'), 100);
    expect(s.dailyPnl).toBe(0);                    // el cierre cayó el 01, T es el 02
  });
});
