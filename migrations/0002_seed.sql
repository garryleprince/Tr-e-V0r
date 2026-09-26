-- Instruments proposés à l'installation. La watchlist active se règle dans
-- l'application (réglages). Les incréments suivent les règles publiques des
-- venues au 26/09/2026 et ne servent qu'à arrondir les quantités simulées.

INSERT OR IGNORE INTO instruments
  (id, provider, symbol, display_name, asset_class, quote_currency, price_increment, size_increment, min_notional, active, created_at)
VALUES
  ('coinbase:BTC-USD', 'coinbase', 'BTC-USD', 'Bitcoin', 'crypto', 'USD', 0.01, 0.00000001, 1, 1, 0),
  ('coinbase:ETH-USD', 'coinbase', 'ETH-USD', 'Ethereum', 'crypto', 'USD', 0.01, 0.00000001, 1, 1, 0),
  ('coinbase:SOL-USD', 'coinbase', 'SOL-USD', 'Solana', 'crypto', 'USD', 0.01, 0.00000001, 1, 1, 0),
  ('alphavantage:SPY', 'alphavantage', 'SPY', 'SPDR S&P 500 ETF', 'etf', 'USD', 0.01, 1, 1, 1, 0),
  ('alphavantage:QQQ', 'alphavantage', 'QQQ', 'Invesco QQQ (Nasdaq-100)', 'etf', 'USD', 0.01, 1, 1, 1, 0);
