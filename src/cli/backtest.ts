import * as v from 'valibot';
import { pathToFileURL } from 'node:url';
import { runBacktest } from '../lib/backtest/run-backtest.ts';
import type { BacktestResult } from '../lib/backtest/types.ts';

const ArgsSchema = v.object({
  strategy: v.string(),
  symbol: v.pipe(v.array(v.string()), v.minLength(1, 'Debes indicar al menos un --symbol')),
  from: v.pipe(v.string(), v.isoTimestamp()),
  to: v.pipe(v.string(), v.isoTimestamp()),
  equity: v.optional(v.pipe(v.number(), v.finite())),
});

// Parseo simple de --clave valor (--symbol repetible).
function parseArgv(argv: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { symbol: [] as string[] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const val = argv[i + 1];
    if (!key || val === undefined) continue;
    if (key === 'symbol') (out.symbol as string[]).push(val);
    else if (key === 'equity') out.equity = Number(val);
    else out[key] = val;
  }
  return out;
}

function pct(x: number): string { return `${x.toFixed(2)}%`; }

function printReport(res: BacktestResult): void {
  const m = res.metrics;
  console.log(`\n=== ${res.symbol} (run ${res.runId}) ===`);
  console.log(`Trades: ${m.trades} | Win rate: ${pct(m.winRate)} | Profit factor: ${m.profitFactor ?? 'n/a'}`);
  console.log(`Retorno total: ${pct(m.totalReturnPct)} | CAGR: ${pct(m.cagrPct)} | Buy&Hold: ${pct(m.buyHoldReturnPct)}`);
  console.log(`Sharpe: ${m.sharpe.toFixed(2)} | Sortino: ${m.sortino.toFixed(2)} | Calmar: ${m.calmar.toFixed(2)}`);
  console.log(`Max DD: ${pct(m.maxDrawdownPct)} | Expectancy: ${m.expectancy.toFixed(2)} | Payoff: ${m.payoffRatio ?? 'n/a'}`);
  console.log(`Exposición: ${pct(m.exposurePct)} | Turnover: ${m.turnover.toFixed(2)}`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = v.parse(ArgsSchema, parseArgv(argv));
  const window = { from: new Date(parsed.from), to: new Date(parsed.to) };
  for (const symbol of parsed.symbol) {
    const res = await runBacktest({ strategyId: parsed.strategy, symbol, window, startingEquity: parsed.equity });
    printReport(res);
  }
}

// v8 ignore next 14 — bloque de arranque CLI; se valida ejecutando `npm run backtest`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await import('dotenv/config');
  const { pool } = await import('../db/pool.ts');
  main(process.argv.slice(2))
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Backtest fallido:', error);
      process.exit(1);
    });
}
