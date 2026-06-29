import { query, type Executor } from '../pool.ts';
import type { Verdict } from '../../lib/execution/types.ts';
import type { LlmVerdict } from '../../lib/reasoning/verdict-schema.ts';

export interface ABRow {
  signalId: string;
  llmVerdict: LlmVerdict;
  llmEscalated: boolean;
  detVerdict: Verdict | null;   // null ⟺ el determinista NO entró (sin fila en decisions)
  realizedPnl: number | null;   // null si no hay posición cerrada
  positionClosed: boolean;
}

interface RawRow {
  signal_id: string; llm_verdict: LlmVerdict; escalated: boolean;
  det_verdict: Verdict | null; realized_pnl: string | number | null; pos_status: string | null;
}

// Read-only. Ancla en shadow_verdicts (tiene enter Y skip del LLM); LEFT JOIN decisions (presente
// solo en det-enter, H1) y positions (resultado en sim). detVerdict null = el determinista no entró.
// DISTINCT ON (signal_id) (M-2): shadow_verdicts es UNIQUE(signal_id), pero decisions NO tiene UNIQUE
// (signal_id). El job-dedup (jobId=signalId) hace que en la práctica haya 1 decisión por señal; el
// DISTINCT ON es una guarda defensiva (toma la decisión más reciente) para que el reporte no duplique
// conteos si alguna vez hubiera dos.
export async function getShadowVsDeterministic(exec: Executor = query): Promise<ABRow[]> {
  const rows = await exec<RawRow>(
    `SELECT DISTINCT ON (sv.signal_id)
            sv.signal_id, sv.verdict AS llm_verdict, sv.escalated,
            d.verdict AS det_verdict, p.realized_pnl, p.status AS pos_status
       FROM kairos.shadow_verdicts sv
       LEFT JOIN kairos.decisions d ON d.signal_id = sv.signal_id
       LEFT JOIN kairos.positions p ON p.decision_id = d.id
      ORDER BY sv.signal_id, d.created_at DESC NULLS LAST`,
  );
  return rows.map((r) => {
    const closed = r.pos_status === 'closed';
    return {
      signalId: r.signal_id, llmVerdict: r.llm_verdict, llmEscalated: r.escalated,
      detVerdict: r.det_verdict, positionClosed: closed,
      realizedPnl: closed && r.realized_pnl !== null ? Number(r.realized_pnl) : null,
    };
  });
}
