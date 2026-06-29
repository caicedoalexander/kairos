// src/lib/reasoning/shadow-report.test.ts
import { describe, test, expect } from 'vitest';
import { computeShadowReport } from './shadow-report.ts';
import type { ABRow } from '../../db/repositories/shadow-report-query.ts';

const llm = (action: 'enter' | 'skip', sizingFactor: number, confianza: 'alta' | 'media' | 'baja' = 'media') =>
  ({ action, entry: 100, sl: 97, tp: 106, sizingFactor, confianza, razonamiento: 'x' });
const det = (sizingFactor: number) => ({ action: 'enter' as const, entry: 100, sl: 97, tp: 106, sizingFactor });

function row(over: Partial<ABRow>): ABRow {
  return { signalId: 's', llmVerdict: llm('enter', 0.5), llmEscalated: false, detVerdict: det(0.5), realizedPnl: null, positionClosed: false, ...over };
}

describe('computeShadowReport', () => {
  test('cuadrantes de acuerdo de acción', () => {
    const rows: ABRow[] = [
      row({ llmVerdict: llm('enter', 0.5), detVerdict: det(0.5) }),   // agreeEnter
      row({ llmVerdict: llm('skip', 0), detVerdict: null }),          // agreeSkip
      row({ llmVerdict: llm('skip', 0), detVerdict: det(0.5) }),      // llmSkipDetEnter
      row({ llmVerdict: llm('enter', 0.5), detVerdict: null }),       // llmEnterDetSkip
    ];
    const r = computeShadowReport(rows);
    expect(r.total).toBe(4);
    expect(r.agreeEnter).toBe(1);
    expect(r.agreeSkip).toBe(1);
    expect(r.llmSkipDetEnter).toBe(1);
    expect(r.llmEnterDetSkip).toBe(1);
    expect(r.agreementRate).toBeCloseTo(0.5);
  });

  test('escalación contada', () => {
    const r = computeShadowReport([row({ llmEscalated: true }), row({ llmEscalated: false })]);
    expect(r.escalatedCount).toBe(1);
    expect(r.escalationRate).toBeCloseTo(0.5);
  });

  test('sizingEdge: solo agreeEnter cerrados con detSizing>0; LLM escala el P&L por su sizing', () => {
    const rows: ABRow[] = [
      // agreeEnter cerrado: det sizing 0.5, llm sizing 0.25 → llmPnl = 10 * (0.25/0.5) = 5
      row({ llmVerdict: llm('enter', 0.25), detVerdict: det(0.5), positionClosed: true, realizedPnl: 10 }),
      // agreeEnter sin cerrar → excluido del P&L
      row({ llmVerdict: llm('enter', 0.5), detVerdict: det(0.5), positionClosed: false, realizedPnl: null }),
    ];
    const r = computeShadowReport(rows);
    expect(r.sizingEdge?.detPnl).toBeCloseTo(10);
    expect(r.sizingEdge?.llmPnl).toBeCloseTo(5);
    expect(r.sizingEdge?.edge).toBeCloseTo(-5);
    expect(r.sizingEdge?.closedCount).toBe(1);
  });

  test('detSizing=0 se excluye del edge (guarda div/0)', () => {
    const r = computeShadowReport([row({ llmVerdict: llm('enter', 0.5), detVerdict: det(0), positionClosed: true, realizedPnl: 10 })]);
    expect(r.sizingEdge?.closedCount).toBe(0);
  });

  test('sin filas → total 0, sizingEdge null', () => {
    const r = computeShadowReport([]);
    expect(r.total).toBe(0);
    expect(r.sizingEdge).toBeNull();
  });
});
