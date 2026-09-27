-- V0.2 — Multi-marchés (crypto, actions US, actions européennes) et multi-devises.
--
-- Les prix, exécutions et frais restent dans la devise de cotation de l'actif.
-- Le cash, le capital et les résultats sont dans la devise du compte ; chaque
-- exécution enregistre le taux de conversion appliqué.

-- Coût d'entrée en devise du compte (hors frais). Positions existantes : même
-- devise que le compte (USD), donc prix moyen × quantité.
ALTER TABLE positions ADD COLUMN entry_value REAL;
UPDATE positions SET entry_value = avg_price * quantity WHERE entry_value IS NULL;

-- Taux devise de cotation → devise du compte au moment de l'exécution.
ALTER TABLE fills ADD COLUMN fx REAL NOT NULL DEFAULT 1;

-- Devise du résultat (devise du compte au moment de la clôture).
ALTER TABLE trades ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';

-- Appels aux fournisseurs à quota (Alpha Vantage gratuit : 25 par jour).
CREATE TABLE vendor_calls (
  vendor TEXT NOT NULL,
  day    INTEGER NOT NULL,   -- début du jour UTC, ms
  calls  INTEGER NOT NULL,
  PRIMARY KEY (vendor, day)
) WITHOUT ROWID;

-- Univers. Symboles Alpha Vantage vérifiés en direct le 27/09/2026 : MC.PAR,
-- SAP.DEX, ASML.AMS, EURUSD (FX_DAILY). Les autres suivent la même convention
-- (ticker de la place + suffixe). Les incréments ne servent qu'à arrondir les
-- quantités simulées : actions à l'unité, crypto au satoshi.
INSERT OR IGNORE INTO instruments
  (id, provider, symbol, display_name, asset_class, quote_currency, price_increment, size_increment, min_notional, active, created_at)
VALUES
  -- Crypto (Coinbase, USD)
  ('coinbase:XRP-USD',  'coinbase', 'XRP-USD',  'XRP',       'crypto', 'USD', 0.0001, 0.000001, 1, 1, 0),
  ('coinbase:ADA-USD',  'coinbase', 'ADA-USD',  'Cardano',   'crypto', 'USD', 0.0001, 0.00000001, 1, 1, 0),
  ('coinbase:DOGE-USD', 'coinbase', 'DOGE-USD', 'Dogecoin',  'crypto', 'USD', 0.00001, 0.1, 1, 1, 0),
  ('coinbase:AVAX-USD', 'coinbase', 'AVAX-USD', 'Avalanche', 'crypto', 'USD', 0.01, 0.00000001, 1, 1, 0),
  ('coinbase:LINK-USD', 'coinbase', 'LINK-USD', 'Chainlink', 'crypto', 'USD', 0.001, 0.00000001, 1, 1, 0),
  ('coinbase:DOT-USD',  'coinbase', 'DOT-USD',  'Polkadot',  'crypto', 'USD', 0.001, 0.00000001, 1, 1, 0),
  -- Actions US (Alpha Vantage, USD)
  ('alphavantage:AAPL',  'alphavantage', 'AAPL',  'Apple',          'equity', 'USD', 0.01, 1, 1, 1, 0),
  ('alphavantage:MSFT',  'alphavantage', 'MSFT',  'Microsoft',      'equity', 'USD', 0.01, 1, 1, 1, 0),
  ('alphavantage:NVDA',  'alphavantage', 'NVDA',  'Nvidia',         'equity', 'USD', 0.01, 1, 1, 1, 0),
  ('alphavantage:AMZN',  'alphavantage', 'AMZN',  'Amazon',         'equity', 'USD', 0.01, 1, 1, 1, 0),
  ('alphavantage:GOOGL', 'alphavantage', 'GOOGL', 'Alphabet',       'equity', 'USD', 0.01, 1, 1, 1, 0),
  ('alphavantage:META',  'alphavantage', 'META',  'Meta Platforms', 'equity', 'USD', 0.01, 1, 1, 1, 0),
  ('alphavantage:TSLA',  'alphavantage', 'TSLA',  'Tesla',          'equity', 'USD', 0.01, 1, 1, 1, 0),
  -- Actions européennes (Alpha Vantage, EUR)
  ('alphavantage:MC.PAR',   'alphavantage', 'MC.PAR',   'LVMH',               'equity', 'EUR', 0.05, 1, 1, 1, 0),
  ('alphavantage:TTE.PAR',  'alphavantage', 'TTE.PAR',  'TotalEnergies',      'equity', 'EUR', 0.01, 1, 1, 1, 0),
  ('alphavantage:AIR.PAR',  'alphavantage', 'AIR.PAR',  'Airbus',             'equity', 'EUR', 0.02, 1, 1, 1, 0),
  ('alphavantage:SAN.PAR',  'alphavantage', 'SAN.PAR',  'Sanofi',             'equity', 'EUR', 0.01, 1, 1, 1, 0),
  ('alphavantage:OR.PAR',   'alphavantage', 'OR.PAR',   'L’Oréal',            'equity', 'EUR', 0.05, 1, 1, 1, 0),
  ('alphavantage:SU.PAR',   'alphavantage', 'SU.PAR',   'Schneider Electric', 'equity', 'EUR', 0.05, 1, 1, 1, 0),
  ('alphavantage:BNP.PAR',  'alphavantage', 'BNP.PAR',  'BNP Paribas',        'equity', 'EUR', 0.01, 1, 1, 1, 0),
  ('alphavantage:SAP.DEX',  'alphavantage', 'SAP.DEX',  'SAP',                'equity', 'EUR', 0.01, 1, 1, 1, 0),
  ('alphavantage:SIE.DEX',  'alphavantage', 'SIE.DEX',  'Siemens',            'equity', 'EUR', 0.01, 1, 1, 1, 0),
  ('alphavantage:ALV.DEX',  'alphavantage', 'ALV.DEX',  'Allianz',            'equity', 'EUR', 0.05, 1, 1, 1, 0),
  ('alphavantage:ASML.AMS', 'alphavantage', 'ASML.AMS', 'ASML',               'equity', 'EUR', 0.1, 1, 1, 1, 0),
  -- Change (sert aux conversions ; non négociable dans l'application)
  ('alphavantage:EURUSD', 'alphavantage', 'EURUSD', 'Euro / Dollar US', 'fx', 'USD', 0.00001, 1, 0, 1, 0);
