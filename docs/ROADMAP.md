# Feuille de route

Légende : ✅ implémenté et testé · 🟡 partiel · ⏳ prévu · ❌ exclu volontairement.
Ce document est mis à jour à chaque version. Il distingue toujours **ce qui est
implémenté** de **ce qui est seulement prévu**.

## V0.1 — Fondations

Interface, authentification, dashboard, données de marché, graphiques,
architecture backend, architecture IA, mode simulation.

Voir [`AUDIT.md`](AUDIT.md) pour l'état exact de chaque exigence à la livraison.

## V0.2 — Marchés, devises, agents et décision

- ✅ Crypto, actions US, actions européennes ; compte en euros avec conversion des actifs en dollars
- ✅ Protection du quota Alpha Vantage ; budget IA illimité au choix

- ⏳ Fundamental Analyst (Alpha Vantage OVERVIEW / EARNINGS, SEC EDGAR « as filed »)
- ⏳ Sentiment Analyst (NEWS_SENTIMENT filtré point-in-time)
- ⏳ Macro Analyst (FRED : taux, inflation ; indices ; corrélations)
- ⏳ Débat consultatif haussier/baissier plafonné en tokens
- ⏳ Régime de marché modulant le budget de risque (FinRL-X)
- ⏳ Passkeys (Face ID)
- ⏳ AI Gateway Cloudflare (journal et plafonds LLM côté plateforme)

## V0.3 — Backtesting, statistiques, mémoire

- ⏳ Écran Backtest : actif, période, stratégie, paramètres, segments TRAIN/VALIDATION/TEST/OOS
- ⏳ Comparaison de stratégies, walk-forward, performances par période
- ⏳ Enregistrement des runs (hash de configuration)
- ⏳ Règlement de **toutes** les décisions (y compris HOLD et refus), MFE/MAE
- ⏳ Étiquetage des erreurs, fiabilité par confiance, régime, actif et consensus
- ⏳ IC / Rank IC des signaux
- ⏳ Réflexions LLM proposées (jamais injectées automatiquement)

## V0.4 — Paper trading avancé, monitoring, alertes

- ⏳ Notifications Web Push (PWA iOS 16.4+)
- ⏳ Stop suiveur, sorties partielles
- ⏳ Ordres limites simulés ; journal d'événements d'ordre complet (event-sourcing)
- ⏳ Tableau de santé : fraîcheur des données, latence LLM, erreurs par fournisseur
- ⏳ Queues Cloudflare si l'univers dépasse la limite CPU d'une invocation

## V1 — Trading réel contrôlé

- ⏳ Adaptateur de venue réelle (Alpaca et/ou Coinbase Advanced / Kraken selon le marché choisi)
- ⏳ Ordres stop posés **chez le broker** (protection même si l'application tombe)
- ⏳ Réconciliation au démarrage et périodique ; statut `UNKNOWN` (Nautilus)
- ⏳ Critères de passage en LIVE (durée paper, nombre de trades, drawdown observé)
- ⏳ Plafond de capital live distinct ; Cloudflare Access recommandé
- ⏳ Labo hors ligne (ML, RL éventuelle) avec validation hors échantillon

## Exclusions volontaires

- ❌ Levier et vente à découvert (jusqu'à une décision explicite et des règles dédiées)
- ❌ Market making, arbitrage, haute fréquence
- ❌ Reinforcement learning sans validation hors échantillon contre des références simples
- ❌ Apprentissage automatique activé sur les résultats passés sans validation
