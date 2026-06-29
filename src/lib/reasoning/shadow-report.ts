// src/lib/reasoning/shadow-report.ts
import type { ABRow } from '../../db/repositories/shadow-report-query.ts';

export interface ShadowReport {
  total: number;
  agreeEnter: number; agreeSkip: number; llmSkipDetEnter: number; llmEnterDetSkip: number;
  agreementRate: number;
  confianzaDist: Record<string, number>;   // sobre veredictos LLM 'enter'
  avgSizingLlm: number | null; avgSizingDet: number | null;   // sobre agreeEnter
  escalatedCount: number; escalationRate: number;
  // Edge de SIZING (M1): SOLO mide la dimensión de sizing condicionada al desenlace determinista.
  // NO modela la divergencia SL/TP del LLM (puede cambiar el signo). llmEnterDetSkip sin P&L observado.
  sizingEdge: { detPnl: number; llmPnl: number; edge: number; closedCount: number } | null;
}

export function computeShadowReport(rows: ABRow[]): ShadowReport {
  const total = rows.length;
  let agreeEnter = 0, agreeSkip = 0, llmSkipDetEnter = 0, llmEnterDetSkip = 0, escalatedCount = 0;
  const confianzaDist: Record<string, number> = {};
  let sumLlm = 0, sumDet = 0, agreeEnterN = 0;
  let detPnl = 0, llmPnl = 0, closedCount = 0;

  for (const r of rows) {
    if (r.llmEscalated) escalatedCount++;
    const detEnter = r.detVerdict !== null;
    const llmEnter = r.llmVerdict.action === 'enter';
    if (llmEnter) confianzaDist[r.llmVerdict.confianza] = (confianzaDist[r.llmVerdict.confianza] ?? 0) + 1;
    if (llmEnter && detEnter) {
      agreeEnter++; agreeEnterN++;
      sumLlm += r.llmVerdict.sizingFactor; sumDet += r.detVerdict!.sizingFactor;
      if (r.positionClosed && r.realizedPnl !== null && r.detVerdict!.sizingFactor > 0) {
        detPnl += r.realizedPnl;
        llmPnl += r.realizedPnl * (r.llmVerdict.sizingFactor / r.detVerdict!.sizingFactor);
        closedCount++;
      }
    } else if (!llmEnter && !detEnter) agreeSkip++;
    else if (!llmEnter && detEnter) llmSkipDetEnter++;
    else llmEnterDetSkip++;
  }

  return {
    total, agreeEnter, agreeSkip, llmSkipDetEnter, llmEnterDetSkip,
    agreementRate: total === 0 ? 0 : (agreeEnter + agreeSkip) / total,
    confianzaDist,
    avgSizingLlm: agreeEnterN === 0 ? null : sumLlm / agreeEnterN,
    avgSizingDet: agreeEnterN === 0 ? null : sumDet / agreeEnterN,
    escalatedCount, escalationRate: total === 0 ? 0 : escalatedCount / total,
    sizingEdge: agreeEnterN === 0 ? null : { detPnl, llmPnl, edge: llmPnl - detPnl, closedCount },
  };
}
