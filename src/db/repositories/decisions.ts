import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { Verdict } from '../../lib/execution/types.ts';

export interface DecisionRecord { id: string; verdict: Verdict; }

// Persiste el veredicto determinista como fila decisions (model_used='deterministic').
// signalId = string devuelto por insertSignal/scanSymbol (la Signal en memoria no lleva id).
export async function persistDecision(
  signalId: string, verdict: Verdict, exec: Executor = query,
): Promise<DecisionRecord> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.decisions (id, signal_id, verdict, reasoning, model_used, tokens)
     VALUES ($1, $2, $3, NULL, 'deterministic', 0)`,
    [id, signalId, JSON.stringify(verdict)],
  );
  return { id, verdict };
}

export async function getDecision(id: string, exec: Executor = query): Promise<DecisionRecord | null> {
  const rows = await exec<{ id: string; verdict: Verdict }>(
    `SELECT id, verdict FROM kairos.decisions WHERE id = $1`, [id],
  );
  return rows[0] ? { id: rows[0].id, verdict: rows[0].verdict } : null;
}

// SP13: lee el verdict (sl/tp) de una decisión para re-proteger una entrada reconciliada.
export async function getDecisionVerdict(decisionId: string, exec: Executor = query): Promise<{ sl: number; tp: number } | null> {
  const rows = await exec<{ verdict: { sl: number; tp: number } }>(
    `SELECT verdict FROM kairos.decisions WHERE id = $1`, [decisionId],
  );
  const v = rows[0]?.verdict;
  return v ? { sl: Number(v.sl), tp: Number(v.tp) } : null;
}
