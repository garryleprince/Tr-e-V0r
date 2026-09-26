# Choix techniques

Pour chaque composant : la technologie proposée, pourquoi, le dépôt qui a inspiré
le choix, pourquoi elle convient ici, et les alternatives écartées.

Règle suivie : **une technologie n'est pas choisie parce qu'elle figure dans un
dépôt.** Tous les dépôts audités sont en Python ou en Rust. Aucun ne s'exécute
sur Cloudflare. Leurs idées sont reprises, pas leurs technologies.

---

## 1. Frontend — React 19 + TypeScript + Vite + Zustand + CSS à tokens

| | |
| --- | --- |
| Pourquoi | Continuité directe avec BoxingCoach : même stack, même design system, même qualité perçue. Bundle léger, rendu prévisible, PWA installable sur iPhone |
| Inspiration | **BoxingCoach** (votre projet). Condor utilise aussi React 19 + Vite pour son dashboard |
| Adapté parce que | Application personnelle, pas de SEO, pas de rendu serveur nécessaire ; build statique servi par Cloudflare |
| Écartées | **Next.js / Remix** : rendu serveur inutile, plus lourds. **SvelteKit** : casserait la continuité avec BoxingCoach. **Streamlit / Dash** (utilisé par FinRL-X) : c'est précisément l'aspect « dashboard Python » à éviter. **Application native Swift** : compte développeur, revue App Store, deux bases de code |

## 2. Graphiques — TradingView Lightweight Charts (Apache-2.0) + SVG maison

| | |
| --- | --- |
| Pourquoi | Conçu pour la finance : chandeliers, histogrammes de volume, séries de lignes et d'aires, lignes de prix (entrée, stop, objectif), marqueurs de trades, zoom et défilement tactiles, rendu canvas rapide. Environ 50 Ko compressés |
| Inspiration | Condor (lightweight-charts 5) ; la convention TradingView du marché |
| Adapté parce que | Lisible sur un écran d'iPhone, performant avec des milliers de barres, thémable avec nos tokens |
| Obligation de licence | La licence impose une **attribution TradingView**. Elle est conservée (logo d'attribution activé et mention dans « À propos ») |
| Écartées | **ECharts** (~300 Ko, style générique). **Recharts** (SVG, lent au-delà de quelques milliers de points, pas de chandelier natif). **Highcharts Stock** (licence commerciale). **Plotly** (lourd, esthétique « notebook ») |

Les mini-graphiques des cartes (sparklines, jauges) restent en SVG inline, comme dans BoxingCoach.

## 3. API et hébergement — Cloudflare Workers + Hono

| | |
| --- | --- |
| Pourquoi | Un seul Worker sert la PWA, l'API et les tâches planifiées. Déploiement par `git push`. Pas de serveur à maintenir. HTTPS et réseau mondial inclus |
| Inspiration | Architecture de déploiement de BoxingCoach (Workers + actifs statiques) |
| Hono | Routeur de 14 Ko, typé, middlewares (auth, CORS, erreurs), conçu pour Workers. Licence MIT |
| Adapté parce que | Charge faible (un utilisateur), besoins de planification couverts par Cron Triggers, secrets gérés nativement |
| Écartées | **FastAPI sur VPS** (modèle de Condor et TradingAgents) : serveur à exploiter, correctifs de sécurité, coût fixe. **Pages Functions** : fonctionnel, mais Workers + Static Assets est la voie actuelle et celle de BoxingCoach. **itty-router** : plus léger mais moins outillé (middlewares, typage des contextes) |

## 4. Validation des données — zod

| | |
| --- | --- |
| Pourquoi | Un seul schéma sert trois usages : validation des entrées API, validation des réglages, **validation des sorties LLM**. Types TypeScript dérivés automatiquement |
| Inspiration | TradingAgents (schémas Pydantic des agents de décision) |
| Adapté parce que | Le SDK Anthropic fournit un helper zod pour les sorties structurées ; les schémas se convertissent en JSON Schema pour les autres fournisseurs |
| Écartées | **Valibot** (plus léger mais moins d'intégrations). **ajv** seul (pas de types dérivés) |

## 5. Base de données — Cloudflare D1 (SQLite)

| | |
| --- | --- |
| Pourquoi | SQL relationnel pour un journal interrogeable (« dans quelles conditions l'agent se trompe-t-il ? »), migrations versionnées, sauvegardes (Time Travel), aucun serveur |
| Inspiration | Condor et FinRL-X (SQLite) ; le Recorder de Qlib pour l'idée d'un historique de runs requêtable |
| Adapté parce que | Volumétrie faible (quelques milliers de décisions par an), latence faible depuis le Worker |
| Écartées | **Postgres externe** (Neon, Supabase) : dépendance, latence et coût supplémentaires, sans besoin réel. **KV** : cohérence éventuelle, inadapté à un registre d'ordres. **SQLite du Durable Object comme base principale** : excellent pour l'état du desk, moins pratique pour les requêtes de l'API |

## 6. Sérialisation et kill switch — Durable Object `TradingDesk`

| | |
| --- | --- |
| Pourquoi | Une seule instance, cohérence forte, traitement séquentiel (verrou interne). Deux propositions simultanées (cron + manuel) ne peuvent pas passer toutes les deux un contrôle d'exposition calculé sur un état périmé |
| Inspiration | Noyau mono-thread et `TradingState` de **NautilusTrader** ; callback de permission de **Condor** |
| Adapté parce que | D1 n'offre que des lots atomiques, pas de lecture-vérification-écriture transactionnelle |
| Écartées | **D1 seul** : condition de course (TOCTOU) sur les limites. **Drapeau KV** : jusqu'à 60 s de propagation pour un arrêt d'urgence, inacceptable |

## 7. Planification — Cron Triggers

| | |
| --- | --- |
| Pourquoi | L'agent travaille sans application ouverte ; précision à la minute ; gratuit |
| Inspiration | Boucle de tick de **Condor** ; rééquilibrage périodique de **FinRL-X** |
| Écartées | **Cron GitHub Actions** : horaires non garantis (retards de plusieurs dizaines de minutes), secrets dispersés. **VPS avec cron** : serveur à maintenir |

## 8. Moteur quantitatif — TypeScript pur (`src/core/quant`)

| | |
| --- | --- |
| Pourquoi | Isomorphe (Worker, navigateur, tests Node), déterministe, testé contre des valeurs de référence. Les indicateurs dont nous avons besoin (SMA, EMA, RSI de Wilder, ATR, MACD, Bollinger, volatilité réalisée, Donchian, pivots) tiennent en quelques centaines de lignes |
| Inspiration | Alpha158 de **Qlib** (familles de features) ; snapshot vérifié de **TradingAgents** (les chiffres viennent du code) |
| Écartées | **Service Python (pandas, Qlib)** : serveur supplémentaire ; réservé au labo hors ligne (V1+). **Bibliothèques npm d'indicateurs** (`technicalindicators`…) : maintenance incertaine, bundle plus lourd, conventions de calcul non maîtrisées |

## 9. Backtest — moteur événementiel TypeScript (`src/core/backtest`)

| | |
| --- | --- |
| Pourquoi | **Parité** avec le paper trading : même `SimulatedExchange`, même Risk Engine. Exécution explicite à l'ouverture de *t+1*. Segments TRAIN / VALIDATION / TEST / OOS contrôlés |
| Inspiration | **NautilusTrader** (parité backtest/live, exécution sur barres), **Qlib** (segments, coûts, métriques), **FinRL-X** (walk-forward) |
| Écartées | **Nautilus en service** : ne tourne pas sur Workers ; gardé comme option derrière `BacktestEngine`. **backtrader** (GPL-3.0), **backtesting.py** (AGPL-3.0) : licences contaminantes. **vectorbt** (Commons Clause) : restrictions d'usage. **bt** (Python) : ne tourne pas sur Workers |

## 10. Couche LLM — interface `LLMProvider` + SDK Anthropic officiel + adaptateur OpenAI-compatible

| | |
| --- | --- |
| Pourquoi | Claude est le cerveau par défaut, via le **SDK officiel `@anthropic-ai/sdk`** (compatible Workers) : sorties structurées, réflexion adaptative, niveau d'effort, repli automatique en cas de refus. L'adaptateur **OpenAI-compatible** couvre GPT, Gemini (endpoint compatible OpenAI), les modèles locaux (Ollama, vLLM, LM Studio) et OpenRouter |
| Inspiration | Usine de fournisseurs, niveaux deep/quick et table de capacités de **TradingAgents** ; option OpenAI-compatible de **Condor** |
| Garde-fous | Passerelle commune : budget journalier en dollars, comptage des tokens, journalisation du prompt et de la réponse, validation zod de la sortie |
| Écartées | **LangChain.js** : couche d'abstraction lourde et changeante, perte d'accès aux fonctions natives de chaque fournisseur. **Vercel AI SDK** : bon outil, mais une dépendance de plus et un plus petit dénominateur commun entre fournisseurs. **Appels HTTP bruts vers Anthropic** : le SDK officiel gère les réessais et le typage |

## 11. Orchestration des agents — pipeline typé maison (`src/core/agents/orchestrator.ts`)

| | |
| --- | --- |
| Pourquoi | Le graphe est fixe et court (analystes en parallèle → consensus → trader → portfolio → risque). Un orchestrateur de 150 lignes, typé et testable sans réseau, suffit |
| Inspiration | Structure du graphe **TradingAgents** ; boucle de tick **Condor** |
| Écartées | **LangGraph.js** : pertinent pour des graphes dynamiques avec outils, surdimensionné ici ; son état en prose est ce que nous voulons éviter. Réévaluable en V0.2 si l'on ajoute des débats multi-tours. **ACP / CLI d'agents** (Condor) : exécution d'outils locaux, incompatible avec Workers et surface d'attaque trop large |

## 12. Données de marché — interface `MarketDataProvider`, routage avec repli

| Adaptateur | Couverture | Clé | Pourquoi |
| --- | --- | --- | --- |
| Coinbase Exchange (public) | Crypto (BTC, ETH, SOL…), bougies 1 min à 1 jour, cotation bid/ask | Non | Gratuit, officiel, stable |
| Kraken (public) | Crypto, bougies 1 min à 1 semaine | Non | Repli si Coinbase ne répond pas |
| Alpha Vantage | Actions, ETF (journalier) | Oui (gratuit : 25 requêtes par jour) | Actions et ETF américains ; aussi utilisé par TradingAgents |

- Inspiration : routage de fournisseurs de **TradingAgents** ; adaptateurs de **Nautilus**.
- Écartées : **yfinance / Yahoo non officiel** (conditions d'utilisation, instabilité).
  **ccxt** (MIT) : excellent, mais plusieurs Mo, trop lourd pour un Worker ;
  possible plus tard dans un service Node dédié.

## 13. Exécution — interface `ExecutionVenue`

| | |
| --- | --- |
| V0.1 | `PaperVenue` : fills simulés par le `SimulatedExchange` (prix de référence ou bid/ask, frais et slippage en points de base) |
| V1 (prévu) | **Alpaca** (actions et crypto, API REST moderne, environnement paper officiel) et/ou **Coinbase Advanced Trade** / **Kraken** pour la crypto. Choix final selon votre marché cible |
| Inspiration | Anatomie de connecteur **Hummingbot** ; `ExecutionClient` et réconciliation **Nautilus** |
| Écartées | **Interactive Brokers** : nécessite TWS ou un Gateway permanent, incompatible avec Workers. **Hummingbot API comme backend d'exécution** : possible plus tard, mais réintroduit un serveur |

## 14. Authentification — compte propriétaire, PBKDF2, sessions serveur

| | |
| --- | --- |
| Pourquoi | Application personnelle : un compte propriétaire créé une seule fois avec un jeton d'installation secret. Mot de passe dérivé par PBKDF2-SHA-256 (WebCrypto natif). Session par cookie `HttpOnly`, `Secure`, `SameSite=Strict`, dont seule l'empreinte est stockée. **Ré-authentification** pour les actions sensibles |
| Inspiration | Sécurité de BoxingCoach (WebCrypto, pas de secret côté client) ; confirmations de **Condor** |
| Défense en profondeur | **Cloudflare Access** (gratuit jusqu'à 50 utilisateurs) peut être placé devant l'application sans changer le code |
| Prévu | Passkeys (Face ID) en V0.2 |
| Écartées | **Auth0, Clerk** : service tiers, coût, dépendance pour un seul utilisateur. **Cloudflare Access seul** : pas de ré-authentification applicative pour les actions sensibles, et une expérience de connexion moins fluide en PWA installée |

Limite de la plateforme : Workers plafonne PBKDF2 à 100 000 itérations.
Argon2 n'est pas natif. La compensation est détaillée dans
[`RISQUE_ET_SECURITE.md`](RISQUE_ET_SECURITE.md).

## 15. Tests — Vitest + Playwright

| | |
| --- | --- |
| Pourquoi | Vitest partage la résolution de modules de Vite (comme BoxingCoach). Playwright pilote Chromium en émulation iPhone pour le parcours réel |
| Inspiration | BoxingCoach (tests des moteurs + parcours navigateur) ; CI multi-fuseaux de **TradingAgents** |
| Écartées | Jest (configuration ESM plus lourde) |

## 16. CI/CD — GitHub + Cloudflare Workers Builds

| | |
| --- | --- |
| Pourquoi | Même logique que BoxingCoach : Cloudflare construit et déploie à chaque push. Les migrations D1 s'appliquent dans la commande de déploiement |
| GitHub Actions | Vérifications à chaque push : types, tests, build. Aucun secret de production nécessaire |
| Écartées | Déploiement manuel `wrangler deploy` (risque d'oubli, pas de traçabilité) |

---

## Coût prévisionnel

| Poste | Estimation |
| --- | --- |
| Cloudflare Workers, D1, DO, Cron | 0 $ en plan gratuit pour un usage léger ; **5 $/mois** en Workers Paid, recommandé dès V0.3 (CPU des backtests) |
| Données crypto | 0 $ (API publiques) |
| Données actions | 0 $ avec Alpha Vantage gratuit (25 requêtes par jour) ; payant au-delà |
| LLM (Claude, `claude-opus-5`, 5 $ / 25 $ par million de tokens en entrée / sortie) | Environ 0,05 à 0,10 $ par analyse complète (2 appels). 3 actifs × 1 analyse par jour ≈ **3 à 9 $ par mois**. Plafond journalier configurable, 2 $ par défaut |
