-- Esquema de dominio de Kairos (append-first). Flue gestiona aparte sus tablas flue_*.
CREATE SCHEMA IF NOT EXISTS kairos;

-- Config declarativa de estrategias (hot-reloadable). trigger_config = árbol de reglas MTF (§16).
CREATE TABLE IF NOT EXISTS kairos.strategies (
  id             text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT false,
  timeframe      text NOT NULL,
  symbols        text[] NOT NULL DEFAULT '{}',
  trigger_config jsonb NOT NULL,
  risk_params    jsonb NOT NULL,
  skill_name     text,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Historial de señales disparadas por el scanner.
CREATE TABLE IF NOT EXISTS kairos.signals (
  id                 text PRIMARY KEY,
  strategy_id        text NOT NULL REFERENCES kairos.strategies(id),
  symbol             text NOT NULL,
  fired_at           timestamptz NOT NULL DEFAULT now(),
  indicator_snapshot jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'fired'
);
CREATE INDEX IF NOT EXISTS signals_symbol_fired_at_idx ON kairos.signals (symbol, fired_at DESC);

-- Razonamiento explícito del decision-maker (append-only).
CREATE TABLE IF NOT EXISTS kairos.decisions (
  id               text PRIMARY KEY,
  signal_id        text NOT NULL REFERENCES kairos.signals(id),
  verdict          jsonb NOT NULL,
  reasoning        text,
  technical_read   jsonb,
  fundamental_read jsonb,
  model_used       text,
  tokens           integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Auditoría del risk gate.
CREATE TABLE IF NOT EXISTS kairos.risk_evaluations (
  id              text PRIMARY KEY,
  decision_id     text NOT NULL REFERENCES kairos.decisions(id),
  result          text NOT NULL CHECK (result IN ('allow', 'deny', 'needs_approval')),
  reason          text,
  adjusted_size   numeric,
  limits_snapshot jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Órdenes: idempotency_key UNIQUE evita duplicados tras crash. purpose/parent_id ligan legs OCO (§18).
CREATE TABLE IF NOT EXISTS kairos.orders (
  id                text PRIMARY KEY,
  idempotency_key   text NOT NULL UNIQUE,
  decision_id       text REFERENCES kairos.decisions(id),
  side              text NOT NULL CHECK (side IN ('buy', 'sell')),
  size              numeric NOT NULL,
  type              text NOT NULL,
  tif               text,
  purpose           text NOT NULL CHECK (purpose IN ('entry', 'sl', 'tp')),
  parent_id         text,
  status            text NOT NULL DEFAULT 'pending',
  exchange_order_id text,
  mode              text NOT NULL CHECK (mode IN ('sim', 'testnet', 'live')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Reconciliación de llenados.
CREATE TABLE IF NOT EXISTS kairos.fills (
  id       text PRIMARY KEY,
  order_id text NOT NULL REFERENCES kairos.orders(id),
  price    numeric NOT NULL,
  qty      numeric NOT NULL,
  fee      numeric NOT NULL DEFAULT 0,
  ts       timestamptz NOT NULL DEFAULT now()
);

-- Posiciones (source of truth). mode aísla sim/testnet/live para el reconciler (§8).
CREATE TABLE IF NOT EXISTS kairos.positions (
  id           text PRIMARY KEY,
  symbol       text NOT NULL,
  side         text NOT NULL CHECK (side IN ('long')),   -- spot long-only; 'short' se añade con futuros (§14)
  entry        numeric NOT NULL,
  size         numeric NOT NULL,
  sl           numeric,
  tp           numeric,
  status       text NOT NULL DEFAULT 'open',
  realized_pnl numeric NOT NULL DEFAULT 0,
  strategy_id  text REFERENCES kairos.strategies(id),
  mode         text NOT NULL CHECK (mode IN ('sim', 'testnet', 'live')),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

-- Snapshots de cuenta para límites de pérdida diaria / drawdown desde el pico (§19).
CREATE TABLE IF NOT EXISTS kairos.account_snapshots (
  id          text PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  equity      numeric NOT NULL,
  peak_equity numeric NOT NULL,
  drawdown    numeric NOT NULL DEFAULT 0,
  daily_pnl   numeric NOT NULL DEFAULT 0
);

-- Circuit-breaker async, resuelto por WhatsApp (§19); NO es pausa de workflow.
CREATE TABLE IF NOT EXISTS kairos.pending_approvals (
  id          text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES kairos.decisions(id),
  reason      text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at  timestamptz NOT NULL,
  resolved_by text,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Rastro completo de eventos.
CREATE TABLE IF NOT EXISTS kairos.audit_log (
  id         text PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  actor      text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON kairos.audit_log (ts DESC);

-- Histórico de velas cerradas (alimenta backtest, §20).
CREATE TABLE IF NOT EXISTS kairos.ohlcv_candles (
  symbol    text NOT NULL,
  timeframe text NOT NULL,
  open_time timestamptz NOT NULL,
  o numeric NOT NULL,
  h numeric NOT NULL,
  l numeric NOT NULL,
  c numeric NOT NULL,
  v numeric NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time)
);

-- Funding histórico del perp (señal de solo-lectura, §15).
CREATE TABLE IF NOT EXISTS kairos.funding_rates (
  symbol text NOT NULL,
  ts     timestamptz NOT NULL,
  rate   numeric NOT NULL,
  PRIMARY KEY (symbol, ts)
);

-- Open interest histórico del perp (señal, §15).
CREATE TABLE IF NOT EXISTS kairos.open_interest (
  symbol   text NOT NULL,
  ts       timestamptz NOT NULL,
  oi       numeric NOT NULL,
  oi_value numeric,
  PRIMARY KEY (symbol, ts)
);

-- Liquidaciones del perp (señal, §15). Las crudas se retienen a corto plazo (§15.3).
CREATE TABLE IF NOT EXISTS kairos.liquidations (
  id       text PRIMARY KEY,
  symbol   text NOT NULL,
  ts       timestamptz NOT NULL,
  side     text NOT NULL CHECK (side IN ('long', 'short')),
  price    numeric NOT NULL,
  qty      numeric NOT NULL,
  notional numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS liquidations_symbol_ts_idx ON kairos.liquidations (symbol, ts DESC);

-- Resultado reproducible de un backtest (§20). symbol/trades añadidos en SP4.
CREATE TABLE IF NOT EXISTS kairos.backtest_runs (
  id               text PRIMARY KEY,
  strategy_id      text NOT NULL REFERENCES kairos.strategies(id),
  strategy_version integer NOT NULL,
  symbol           text,
  "window"         tstzrange,
  mode             text NOT NULL CHECK (mode IN ('det', 'llm')),
  sim_params       jsonb NOT NULL,
  metrics          jsonb NOT NULL,
  trades           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Idempotente para DBs migradas antes de SP4 (CREATE IF NOT EXISTS no altera columnas existentes).
ALTER TABLE kairos.backtest_runs ADD COLUMN IF NOT EXISTS symbol text;
ALTER TABLE kairos.backtest_runs ADD COLUMN IF NOT EXISTS trades jsonb NOT NULL DEFAULT '[]'::jsonb;
