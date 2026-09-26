-- Tr-e-V0r — schéma initial (V0.1).
-- Toutes les heures sont en millisecondes UTC. Les montants en devise de cotation.
-- Voir docs/ARCHITECTURE.md §6.

-- ------------------------------------------------------------ authentification

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  failed_logins       INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER,
  created_at          INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);

-- Seule l'empreinte SHA-256 du jeton de session est stockée.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  step_up_until INTEGER NOT NULL DEFAULT 0,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  ip_hash TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  success INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts(ip_hash, ts);

-- -------------------------------------------------------------------- réglages

-- Valeurs JSON, validées par les schémas zod de src/core/domain/settings.ts.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------------- marché

CREATE TABLE instruments (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  asset_class     TEXT NOT NULL,
  quote_currency  TEXT NOT NULL,
  price_increment REAL NOT NULL,
  size_increment  REAL NOT NULL,
  min_notional    REAL NOT NULL,
  -- Jamais supprimé : un instrument retiré reste pour éviter le biais du survivant.
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

-- Bougies FERMÉES uniquement, identifiées par leur heure d'ouverture.
CREATE TABLE candles (
  instrument_id TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  t             INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  source        TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, timeframe, t)
) WITHOUT ROWID;

CREATE TABLE candle_fetches (
  instrument_id TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT,
  PRIMARY KEY (instrument_id, timeframe)
) WITHOUT ROWID;

CREATE TABLE quotes (
  instrument_id TEXT PRIMARY KEY,
  bid           REAL,
  ask           REAL,
  last          REAL NOT NULL,
  ts            INTEGER NOT NULL,
  source        TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);

-- ------------------------------------------------------------ analyses et agents

CREATE TABLE analysis_runs (
  id            TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  trigger       TEXT NOT NULL,         -- schedule | manual
  mode          TEXT NOT NULL,         -- RESEARCH | PAPER | LIVE
  trading_state TEXT NOT NULL,         -- ACTIVE | REDUCING | HALTED
  status        TEXT NOT NULL,         -- running | completed | failed | skipped
  as_of         INTEGER,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  data_source   TEXT,
  snapshot      TEXT,                  -- TechnicalSnapshot (JSON) : les données disponibles
  consensus     TEXT,
  error         TEXT,
  llm_cost_usd  REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_runs_started ON analysis_runs(started_at DESC);
CREATE INDEX idx_runs_instrument ON analysis_runs(instrument_id, started_at DESC);

CREATE TABLE agent_reports (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  agent         TEXT NOT NULL,         -- technical | fundamental | sentiment | macro | trader
  status        TEXT NOT NULL,         -- ok | unavailable | error
  stance        TEXT,
  confidence    REAL,
  summary       TEXT NOT NULL,
  details       TEXT NOT NULL,
  source        TEXT NOT NULL,         -- llm | rules | none
  provider      TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  latency_ms    INTEGER,
  transcript    TEXT,                  -- prompt envoyé et réponse brute (audit)
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_reports_run ON agent_reports(run_id);
CREATE INDEX idx_reports_created ON agent_reports(created_at);

CREATE TABLE decisions (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  instrument_id    TEXT NOT NULL,
  mode             TEXT NOT NULL,
  action           TEXT,               -- BUY | SELL | HOLD ; NULL si INVALID
  status           TEXT NOT NULL,
  source           TEXT NOT NULL,      -- llm | rules
  confidence       REAL,
  entry_price      REAL,
  stop_loss        REAL,
  take_profit      REAL,
  horizon_bars     INTEGER,
  size_pct         REAL,
  reference_price  REAL NOT NULL,
  as_of            INTEGER NOT NULL,
  proposal         TEXT,               -- TradeProposal complète (JSON)
  invalid_reasons  TEXT,
  plan_explanation TEXT,
  execution_note   TEXT,
  created_at       INTEGER NOT NULL,
  settled_at       INTEGER,
  outcome_return   REAL,
  outcome_label    TEXT
);
CREATE INDEX idx_decisions_created ON decisions(created_at DESC);
CREATE INDEX idx_decisions_instrument ON decisions(instrument_id, created_at DESC);

CREATE TABLE risk_verdicts (
  id              TEXT PRIMARY KEY,
  decision_id     TEXT REFERENCES decisions(id) ON DELETE CASCADE,
  origin          TEXT NOT NULL,       -- ai | protective | manual
  outcome         TEXT NOT NULL,       -- APPROVED | RESIZED | REJECTED
  requested_qty   REAL NOT NULL,
  approved_qty    REAL NOT NULL,
  checks          TEXT NOT NULL,       -- chaque règle : valeur, limite, résultat
  limits_snapshot TEXT NOT NULL,       -- limites en vigueur au moment du verdict
  trading_state   TEXT NOT NULL,
  summary         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_verdicts_decision ON risk_verdicts(decision_id);

-- --------------------------------------------------------- desk et portefeuille

-- État du desk. Écrit UNIQUEMENT par le Durable Object TradingDesk.
CREATE TABLE desk_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  mode          TEXT NOT NULL,
  trading_state TEXT NOT NULL,
  reason        TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE accounts (
  mode               TEXT PRIMARY KEY,
  currency           TEXT NOT NULL,
  starting_cash      REAL NOT NULL,
  cash               REAL NOT NULL,
  peak_equity        REAL NOT NULL,
  day_start_equity   REAL NOT NULL,
  day                INTEGER NOT NULL,
  consecutive_losses INTEGER NOT NULL DEFAULT 0,
  last_loss_at       INTEGER,
  created_at         INTEGER NOT NULL,
  reset_at           INTEGER NOT NULL
);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL UNIQUE,
  mode            TEXT NOT NULL,
  venue           TEXT NOT NULL,
  instrument_id   TEXT NOT NULL,
  decision_id     TEXT,
  verdict_id      TEXT,
  side            TEXT NOT NULL,
  type            TEXT NOT NULL,
  quantity        REAL NOT NULL,
  reference_price REAL NOT NULL,
  status          TEXT NOT NULL,       -- FILLED | REJECTED | CANCELLED | PENDING
  origin          TEXT NOT NULL,       -- ai | protective | manual
  reason          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_orders_created ON orders(mode, created_at DESC);

CREATE TABLE fills (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  price        REAL NOT NULL,
  quantity     REAL NOT NULL,
  fee          REAL NOT NULL,
  slippage_bps REAL NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE INDEX idx_fills_order ON fills(order_id);

CREATE TABLE positions (
  id              TEXT PRIMARY KEY,
  mode            TEXT NOT NULL,
  instrument_id   TEXT NOT NULL,
  status          TEXT NOT NULL,       -- open | closed
  quantity        REAL NOT NULL,
  avg_price       REAL NOT NULL,
  entry_fees      REAL NOT NULL,
  stop_loss       REAL,
  take_profit     REAL,
  expires_at      INTEGER,
  opened_at       INTEGER NOT NULL,
  closed_at       INTEGER,
  exit_price      REAL,
  realized_pnl    REAL,
  exit_reason     TEXT,
  decision_id     TEXT,
  last_checked_at INTEGER NOT NULL
);
CREATE INDEX idx_positions_status ON positions(mode, status);
CREATE UNIQUE INDEX idx_positions_one_open ON positions(mode, instrument_id) WHERE status = 'open';

CREATE TABLE trades (
  id            TEXT PRIMARY KEY,
  mode          TEXT NOT NULL,
  position_id   TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  quantity      REAL NOT NULL,
  entry_price   REAL NOT NULL,
  exit_price    REAL NOT NULL,
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER NOT NULL,
  pnl           REAL NOT NULL,
  return_pct    REAL NOT NULL,
  exit_reason   TEXT NOT NULL,
  decision_id   TEXT
);
CREATE INDEX idx_trades_closed ON trades(mode, closed_at DESC);

CREATE TABLE equity_snapshots (
  mode           TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  cash           REAL NOT NULL,
  equity         REAL NOT NULL,
  exposure       REAL NOT NULL,
  drawdown       REAL NOT NULL,
  open_positions INTEGER NOT NULL,
  PRIMARY KEY (mode, ts)
) WITHOUT ROWID;

-- ------------------------------------------------------------ audit et alertes

CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  ts              INTEGER NOT NULL,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL,       -- info | warning | critical
  actor           TEXT NOT NULL,       -- user | system | agent | risk
  title           TEXT NOT NULL,
  data            TEXT,
  acknowledged_at INTEGER
);
CREATE INDEX idx_events_ts ON events(ts DESC);

CREATE TABLE job_heartbeats (
  name        TEXT PRIMARY KEY,
  last_run_at INTEGER NOT NULL,
  last_status TEXT NOT NULL,
  detail      TEXT
);
