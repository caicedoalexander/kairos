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
  fundamentalRead: unknown | null;
  fundamentalModel: string | null;
  fundamentalTokens: number | null;
  fundamentalStatus: string | null;
  fundamentalFetchOk: boolean | null;
  escalated: boolean;
}

// Append-first; ON CONFLICT (signal_id) DO NOTHING hace la inserción idempotente ante carreras.
// Los reads van en el MISMO INSERT del veredicto (no hay segunda fila ni segunda capa).
export async function insertShadowVerdict(row: ShadowVerdictRow, exec: Executor = query): Promise<void> {
  await exec(
    `INSERT INTO kairos.shadow_verdicts
       (id, signal_id, verdict, confianza, razonamiento, model_used, tokens,
        technical_read, technical_model, technical_tokens,
        fundamental_read, fundamental_model, fundamental_tokens, fundamental_status, fundamental_fetch_ok, escalated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (signal_id) DO NOTHING`,
    [ulid(), row.signalId, JSON.stringify(row.verdict), row.confianza, row.razonamiento, row.modelUsed, row.tokens,
     row.technicalRead === null ? null : JSON.stringify(row.technicalRead), row.technicalModel, row.technicalTokens,
     row.fundamentalRead === null ? null : JSON.stringify(row.fundamentalRead), row.fundamentalModel, row.fundamentalTokens,
     row.fundamentalStatus, row.fundamentalFetchOk, row.escalated],
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
  fundamental_read: unknown | null; fundamental_model: string | null; fundamental_tokens: number | null;
  fundamental_status: string | null; fundamental_fetch_ok: boolean | null;
  escalated: boolean;
}

export async function getShadowVerdict(signalId: string, exec: Executor = query): Promise<ShadowVerdictRow | null> {
  const rows = await exec<ShadowRow>(
    `SELECT signal_id, verdict, confianza, razonamiento, model_used, tokens,
            technical_read, technical_model, technical_tokens,
            fundamental_read, fundamental_model, fundamental_tokens, fundamental_status, fundamental_fetch_ok,
            escalated
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
    fundamentalRead: r.fundamental_read, fundamentalModel: r.fundamental_model,
    fundamentalTokens: r.fundamental_tokens === null ? null : Number(r.fundamental_tokens),
    fundamentalStatus: r.fundamental_status, fundamentalFetchOk: r.fundamental_fetch_ok,
    escalated: r.escalated,
  };
}
