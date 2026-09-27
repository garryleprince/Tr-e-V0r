# Notices tierces

## Projets étudiés (inspiration conceptuelle, aucun code copié)

L'architecture de Tr-e-V0r reprend des **concepts** issus des projets suivants.
Aucun fichier source, aucun prompt et aucune donnée de ces projets n'a été copié.
Les formules d'indicateurs et de métriques utilisées sont des définitions
publiques standard, réimplémentées et testées. Détails : `docs/audit/`.

| Projet | Licence | Concepts repris |
| --- | --- | --- |
| TradingAgents — TauricResearch | Apache-2.0 | Rôles d'agents, sorties structurées, garde-fous point-in-time, mémoire à règlement différé |
| Qlib — Microsoft | MIT | Segments de validation, décalage d'exécution, modèle de coûts, métriques |
| NautilusTrader — Nautech Systems | LGPL-3.0 | Risk Engine entre décision et exécution, états ACTIVE/REDUCING/HALTED, parité backtest/live |
| FinRL — AI4Finance Foundation | MIT | Sélection par validation, critique de la RL en P&L brut |
| FinRL-Trading (FinRL-X) — AI4Finance Foundation | Apache-2.0 | Contrat par exposition cible, overlay de risque, refroidissement |
| Hummingbot — Hummingbot Foundation | Apache-2.0 | Anatomie des connecteurs, triple barrière, budget checker |
| Condor — Hummingbot Foundation | MIT | Séparation déterministe/raisonnement, interception des actions par le risque, plafond de coût LLM |

NautilusTrader est une marque de Nautech Systems. Tr-e-V0r n'est ni affilié ni approuvé.

## Dépendances distribuées avec l'application

La liste complète et à jour est générée à partir de `package.json`. Principales dépendances :

| Paquet | Licence | Note |
| --- | --- | --- |
| react, react-dom | MIT | |
| zustand | MIT | |
| zod | MIT | |
| hono | MIT | |
| @anthropic-ai/sdk | MIT | |
| lightweight-charts (TradingView) | Apache-2.0 | **Attribution TradingView requise** : conservée via l'option `attributionLogo` et la page « À propos ». Voir https://www.tradingview.com/ |

## Sources de données de marché

| Source | Accès | Conditions |
| --- | --- | --- |
| Banque centrale européenne — taux de référence de l'euro | Libre, sans clé | Réutilisation autorisée avec mention de la source : « Source : BCE ». Affichée dans « À propos » |
| Coinbase Exchange, Kraken | API publiques, sans clé | Conditions d'utilisation de chaque plateforme |
| Yahoo Finance | **Non officiel**, sans clé | Aucune API publique depuis 2017 ; les conditions de Yahoo n'autorisent pas l'accès automatisé. Utilisé à la demande du propriétaire, pour un usage personnel, et signalé comme non officiel dans l'interface |
| Alpha Vantage | Clé (facultative) | Conditions de l'offre souscrite |

## Outils de développement (non distribués avec l'application)

| Paquet | Licence | Usage |
| --- | --- | --- |
| playwright-core (Microsoft) | Apache-2.0 | Parcours e2e sur iPhone émulé et génération des icônes PNG |
| vite, vitest, typescript, wrangler | MIT / Apache-2.0 | Build, tests, typage, Worker local |
