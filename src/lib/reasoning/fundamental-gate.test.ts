import { describe, test, expect } from 'vitest';
import { isMajorCap, shouldRunFundamental } from './fundamental-gate.ts';
import type { IndicatorSnapshot } from '../scanner/types.ts';
import type { NewsItem } from '../sources/news.ts';

const NEWS: NewsItem[] = [{ title: 'x', publishedAt: '2026-06-28T11:00:00Z', kind: 'news', url: 'u' }];
function snap(fundingZ: number | null, oiChangePct: number | null): IndicatorSnapshot {
  return { byTimeframe: {}, mtfAlignment: 'aligned', levels: { support: null, resistance: null }, derivatives: { fundingZ, oiChangePct } };
}

describe('isMajorCap', () => {
  test('BTC y ETH son major-caps; las alts no', () => {
    expect(isMajorCap('BTC/USDT')).toBe(true);
    expect(isMajorCap('ETH/USDT')).toBe(true);
    expect(isMajorCap('SOL/USDT')).toBe(false);
  });
});

describe('shouldRunFundamental', () => {
  test('catalizador en ventana → true (sin importar derivados)', () => {
    expect(shouldRunFundamental(NEWS, snap(null, null))).toBe(true);
  });
  test('sin noticias pero funding extremo → true', () => {
    expect(shouldRunFundamental([], snap(2.4, null))).toBe(true);
  });
  test('sin noticias pero OI extremo → true', () => {
    expect(shouldRunFundamental([], snap(null, 15))).toBe(true);
  });
  test('sin noticias y derivados normales → false', () => {
    expect(shouldRunFundamental([], snap(0.5, 3))).toBe(false);
  });
  test('sin noticias y derivados null → false', () => {
    expect(shouldRunFundamental([], snap(null, null))).toBe(false);
  });
});
