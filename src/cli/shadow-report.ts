// src/cli/shadow-report.ts
// CLI read-only: imprime el reporte A/B (LLM sombra vs determinista). No muta nada.
import { getShadowVsDeterministic } from '../db/repositories/shadow-report-query.ts';
import { computeShadowReport } from '../lib/reasoning/shadow-report.ts';
import { pool } from '../db/pool.ts';

async function main(): Promise<void> {
  const rows = await getShadowVsDeterministic();
  const r = computeShadowReport(rows);
  const out = [
    '=== Reporte A/B: LLM (sombra) vs determinista ===',
    `Total señales con veredicto LLM: ${r.total}`,
    '',
    'Acuerdo de acción:',
    `  ambos enter:        ${r.agreeEnter}`,
    `  ambos skip:         ${r.agreeSkip}`,
    `  LLM skip / det enter: ${r.llmSkipDetEnter}`,
    `  LLM enter / det skip: ${r.llmEnterDetSkip}  (sin P&L observado)`,
    `  tasa de acuerdo:    ${(r.agreementRate * 100).toFixed(1)}%`,
    '',
    `Confianza LLM (en enters): ${JSON.stringify(r.confianzaDist)}`,
    `Sizing medio (agree-enter): LLM=${r.avgSizingLlm?.toFixed(3) ?? 'n/a'}  det=${r.avgSizingDet?.toFixed(3) ?? 'n/a'}`,
    `Escalación a Opus: ${r.escalatedCount}/${r.total} (${(r.escalationRate * 100).toFixed(1)}%)`,
    '',
    'Edge de SIZING (solo agree-enter cerrados; NO modela divergencia SL/TP del LLM):',
    r.sizingEdge
      ? `  det P&L=${r.sizingEdge.detPnl.toFixed(2)}  LLM P&L=${r.sizingEdge.llmPnl.toFixed(2)}  edge=${r.sizingEdge.edge.toFixed(2)}  (n=${r.sizingEdge.closedCount})`
      : '  (sin posiciones cerradas en agree-enter)',
  ].join('\n');
  process.stdout.write(out + '\n');
  await pool.end();
}

// v8 ignore next 4 — bloque de arranque CLI
main().catch((err) => {
  process.stderr.write(`shadow-report falló: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
