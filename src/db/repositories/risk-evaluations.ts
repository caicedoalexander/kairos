import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';
import type { RiskResult } from '../../lib/execution/types.ts';

export async function insertRiskEvaluation(
  decisionId: string, result: RiskResult, exec: Executor = query,
): Promise<string> {
  const id = ulid();
  await exec(
    `INSERT INTO kairos.risk_evaluations (id, decision_id, result, reason, adjusted_size, limits_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, decisionId, result.result, result.reason, result.adjustedSize, JSON.stringify(result.limitsSnapshot)],
  );
  return id;
}
