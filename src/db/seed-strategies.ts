import { pathToFileURL } from 'node:url';

const TRIGGER_CONFIG = {
  timeframes: { bias: '4h', context: '1h', trigger: '15m' },
  entry: {
    all: [
      { tf: '4h', predicate: 'ema_stack_bullish' },
      { tf: '1h', predicate: 'above_vwap' },
      { tf: '15m', predicate: 'rsi_cross_up', args: { level: 40 } },
      { tf: '15m', predicate: 'near_support', args: { max_dist_pct: 0.5 } },
    ],
  },
  skip: {
    any: [
      { tf: '15m', predicate: 'atr_pct_above', args: { max: 4 } },
      { predicate: 'funding_z_extreme', args: { max_abs: 2.5 } },
    ],
  },
};
const RISK_PARAMS = {
  risk_per_trade_pct: 0.5,
  atr_stop_mult: 1.5,
  tp_r_multiple: 2.0,
  max_notional_pct: 10,
  max_total_exposure_pct: 30,
  max_open_positions: 3,
  max_symbol_exposure_pct: 15,
  max_daily_loss_pct: 3,
  max_drawdown_pct: 15,
  max_consecutive_losses: 4,
};

// Siembra la estrategia semilla pullback-alcista (§16.3). Idempotente: refresca config si ya existe.
export async function seedStrategies(): Promise<void> {
  const { query } = await import('./pool.ts');
  await query(
    `INSERT INTO kairos.strategies (id, enabled, timeframe, symbols, trigger_config, risk_params, version)
     VALUES ($1, true, '15m', $2::text[], $3, $4, 2)
     ON CONFLICT (id) DO UPDATE
       SET trigger_config = EXCLUDED.trigger_config,
           risk_params    = EXCLUDED.risk_params,
           enabled        = EXCLUDED.enabled,
           timeframe      = EXCLUDED.timeframe,
           version        = EXCLUDED.version`,
    ['pullback-alcista', '{BTC/USDT,ETH/USDT}', JSON.stringify(TRIGGER_CONFIG), JSON.stringify(RISK_PARAMS)],
  );
}

// v8 ignore start — entrypoint CLI; se valida con `npm run seed`, no en unit tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await import('dotenv/config');
  const { pool } = await import('./pool.ts');
  seedStrategies()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Seed de estrategias falló:', error);
      process.exit(1);
    });
}
// v8 ignore stop
