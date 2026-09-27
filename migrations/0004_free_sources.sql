-- Sources sans clé (choix du propriétaire, 27/09/2026) :
-- - actions et ETF : Yahoo Finance (source non officielle), Alpha Vantage en
--   secours uniquement si une clé est configurée ;
-- - change EUR/USD : Banque centrale européenne (taux de référence officiels).
--
-- Les identifiants d'instruments ne changent pas (ils sont référencés par le
-- journal et les réglages) : seul le fournisseur PRÉFÉRÉ change.
UPDATE instruments SET provider = 'yahoo' WHERE asset_class IN ('equity', 'etf');
UPDATE instruments SET provider = 'ecb' WHERE asset_class = 'fx' AND symbol LIKE 'EUR%';
