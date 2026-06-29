import { ulid } from 'ulidx';
import { query, type Executor } from '../pool.ts';

export interface ShadowVerdictRow {
  signalId: string;
  verdict: unknown;
  confianza: string;
  razonamiento: string | null;
  modelUsed: string | null;
  tokens: number | null;
  technicalRead: unknown | null;
  technicalModel: string | null;
  technicalTokens: number | null;
}

// Append-first; ON CONFLICT (signal_id) DO NOTHING hace la inserción idempotente ante carreras.
// El technical_read va en el MISMO INSERT del veredicto (no hay segunda fila ni segunda capa).
export async function insertShadowVerdict(row: ShadowVerdictRow, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.shadow_verdicts
       (id, signal_id, verdict, confianza, razonamiento, model_used, tokens,
        technical_read, technical_model, technical_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (signal_id) DO NOTHING`,
    [ulid(), row.signalId, JSON.stringify(row.verdict), row.confianza, row.razonamiento, row.modelUsed, row.tokens,
     row.technicalRead === null ? null : JSON.stringify(row.technicalRead), row.technicalModel, row.technicalTokens],
  );
}

export async function isAlreadyEvaluated(signalId: string, exec: Executor = query): Promise<boolean> {
  const rows = await exec(`SELECT 1 FROM kairos.shadow_verdicts WHERE signal_id = $1 LIMIT 1`, [signalId]);
  return rows.length > 0;
}

interface ShadowRow {
  signal_id: string; verdict: unknown; confianza: string; razonamiento: string | null;
  model_used: string | null; tokens: number | null;
  technical_read: unknown | null; technical_model: string | null; technical_tokens: number | null;
}

export async function getShadowVerdict(signalId: string, exec: Executor = query): Promise<ShadowVerdictRow | null> {
  const rows = await exec<ShadowRow>(
    `SELECT signal_id, verdict, confianza, razonamiento, model_used, tokens,
            technical_read, technical_model, technical_tokens
       FROM kairos.shadow_verdicts WHERE signal_id = $1`,
    [signalId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    signalId: r.signal_id, verdict: r.verdict, confianza: r.confianza, razonamiento: r.razonamiento,
    modelUsed: r.model_used, tokens: r.tokens === null ? null : Number(r.tokens),
    technicalRead: r.technical_read, technicalModel: r.technical_model,
    technicalTokens: r.technical_tokens === null ? null : Number(r.technical_tokens),
  };
}
