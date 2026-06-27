import { scan } from '../scanner/scan.ts';
import { buildDeterministicVerdict } from '../execution/verdict.ts';
import { evaluateRisk } from '../execution/check-risk.ts';
import { simulateFill } from '../execution/fill.ts';
import { resolveBracket } from '../execution/bracket.ts';
import { parseRiskParams } from '../execution/types.ts';
import { emptyLedger, applyOpen, applyClose, markEquity, markToMarket, gatherState } from './accounting.ts';
import type { BacktestDataSource } from './data-source.ts';
import type { Strategy } from '../scanner/types.ts';
import type { SimParams, Verdict } from '../execution/types.ts';
import type { Ledger, EquityPoint, ReplayOutput } from './types.ts';

export interface ReplayConfig { startingEquity: number; simParams: SimParams; }
interface PendingEntry { verdict: Verdict; size: number; }

export function runReplay(strategy: Strategy, symbol: string, ds: BacktestDataSource, cfg: ReplayConfig): ReplayOutput {
  const rp = parseRiskParams(strategy.riskParams);
  const bars = ds.triggerCandles;
  let ledger: Ledger = emptyLedger(cfg.startingEquity);
  let pending: PendingEntry | null = null;
  const equityCurve: EquityPoint[] = [];

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const T = ds.closeTimeAt(i);

    // 1. Materializar entrada pendiente al open de esta barra.
    if (pending && !ledger.open) {
      const fill = simulateFill('buy', pending.size, b.o, cfg.simParams);
      ledger = applyOpen(ledger, { entry: fill.fillPrice, size: fill.qty, sl: pending.verdict.sl, tp: pending.verdict.tp, entryFee: fill.fee, openedAt: T });
      pending = null;
    }

    // 2. Salida sobre esta barra (SL primero lo garantiza resolveBracket).
    if (ledger.open) {
      const o = ledger.open;
      const res = resolveBracket(
        { entry: o.entry, size: o.size, sl: o.sl, tp: o.tp, entryFee: o.entryFee },
        { open: b.o, high: b.h, low: b.l, close: b.c },
        cfg.simParams,
      );
      if (res) ledger = applyClose(ledger, res, o.openedAt, T);
    }

    // 3. Decisión de entrada (se materializa en la barra siguiente).
    if (!ledger.open && !pending) {
      const signal = scan(strategy, symbol, ds.closedCandlesAt(i), ds.derivativesAt(T), T);
      if (signal) {
        const verdict = buildDeterministicVerdict(signal, strategy);
        if (verdict.action === 'enter') {
          const state = gatherState(ledger, T, b.c);
          const risk = evaluateRisk({ verdict, riskParams: rp, ...state });
          if (risk.result === 'allow' && risk.adjustedSize !== null) {
            pending = { verdict, size: risk.adjustedSize };
          }
        }
      }
    }

    // 4. Marca de equity.
    ledger = markEquity(ledger, b.c);
    equityCurve.push({ t: T, equity: markToMarket(ledger, b.c) });
  }

  // Cierre end-of-data si queda posición abierta.
  if (ledger.open && bars.length > 0) {
    const last = bars[bars.length - 1];
    const o = ledger.open;
    const exitFee = last.c * o.size * (cfg.simParams.fee_bps / 1e4);
    const realizedPnl = (last.c - o.entry) * o.size - o.entryFee - exitFee;
    ledger = applyClose(ledger, { hitType: 'eod', exitPrice: last.c, exitFee, realizedPnl }, o.openedAt, ds.closeTimeAt(bars.length - 1));
  }

  return { trades: [...ledger.trades], equityCurve, finalLedger: ledger };
}
