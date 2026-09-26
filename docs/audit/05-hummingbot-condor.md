# Fiche 5 — Hummingbot et Condor (Hummingbot Foundation)

| | Hummingbot | Condor |
| --- | --- | --- |
| Dépôt | https://github.com/hummingbot/hummingbot | https://github.com/hummingbot/condor |
| Commit analysé | `9af100d` (22 sept. 2026) | `d89e74f` (16 sept. 2026) |
| Licence | **Apache-2.0** (vérifiée) | **MIT** (vérifiée) |
| Langage | Python + Cython | Python (FastAPI, bot Telegram) + frontend React 19 / Vite / lightweight-charts |
| Positionnement | Framework de bots de trading, surtout crypto (market making, arbitrage, directionnel) | Interface Telegram et web, et **agents de trading IA** au-dessus de l'API Hummingbot |

---

## 1. Hummingbot

### 1.1 Objectif

Exécuter des stratégies algorithmiques sur plus de 25 exchanges centralisés et
plusieurs DEX (via Gateway), avec une couche de connecteurs unifiée.

### 1.2 Connecteurs (`hummingbot/connector/`)

Structure type d'un connecteur, par exemple Kraken :

| Fichier | Rôle |
| --- | --- |
| `*_exchange.py` | classe principale (hérite de `ExchangePyBase`) |
| `*_auth.py` | signature REST et WebSocket (nonce, HMAC) |
| `*_api_order_book_data_source.py` | flux public (carnet, trades) |
| `*_api_user_stream_data_source.py` | flux privé WebSocket (ordres, soldes) |
| `*_constants.py` | URLs, limites de débit, mapping des statuts |
| `*_web_utils.py` | construction des requêtes |

`ExchangePyBase` fournit la mécanique commune :

- **limiteur de débit** (`AsyncThrottler`, `rate_limits_rules`) ;
- **synchronisation d'horloge** avec le serveur (`TimeSynchronizer`), sans
  laquelle les requêtes signées sont rejetées ;
- **règles de trading** par paire, rafraîchies périodiquement : quantums de prix
  et de taille, minimum notionnel (`get_order_price_quantum`, `get_order_size_quantum`) ;
- **suivi des ordres en vol** (`ClientOrderTracker`) : identifiant client,
  détection des ordres « perdus » après N échecs de mise à jour, restauration de
  l'état au redémarrage ;
- boucles de polling (statut, soldes, fills), qui complètent le WebSocket quand il décroche ;
- `BudgetChecker` : **verrouille le collatéral** des ordres hypothétiques avant
  envoi, pour qu'une série d'ordres ne dépasse pas le solde disponible.

Connecteur `paper_trade` : exchange simulé qui s'appuie sur les carnets réels.

### 1.3 Stratégies V2 (`strategy_v2/`)

- **Controllers**, qui décident (directionnel, market making), et **Executors**,
  qui exécutent : position, DCA, grid, TWAP, arbitrage, XEMM, LP.
- `PositionExecutor` avec **triple barrière** (`TripleBarrierConfig`) : stop-loss,
  take-profit, limite de temps et stop suiveur. Validations :
  - barrières strictement positives ;
  - stop et limite de temps exécutés **au marché**, pour sortir à tout prix ;
  - ajustement des barrières à la volatilité (`new_instance_with_adjusted_volatility`).
- Contrôleur directionnel : nombre d'executors par côté, **cooldown** après signal.
- `BacktestingEngineBase` : simule les executors sur des bougies historiques.

### 1.4 Limites

- Orienté market making et crypto haute fréquence, loin de notre besoin de
  décision raisonnée.
- Cython et processus longue durée : incompatible avec Workers.
- Valeurs par défaut risquées : **levier 20× par défaut** dans le contrôleur
  directionnel (`leverage: default=20`). Contre-exemple à ne pas suivre.

---

## 2. Condor : les agents de trading IA

### 2.1 Philosophie (`condor/agents/README.md`)

> « LLMs are powerful reasoners but terrible at the mechanical parts of trading […]
> This framework splits the problem in two. »

- **Couche déterministe** : routines, fournisseurs de données, executors. Elle
  récupère le marché, calcule les indicateurs, suit positions et PnL, fait
  respecter les limites.
- **Couche de raisonnement** (tick LLM) : elle lit un snapshot pré-calculé, son
  journal et ses leçons, puis décide *quoi faire*.
- **Le LLM ne place jamais d'ordre individuel.** Il manipule uniquement des
  *executors*, marqués d'un `controller_id` propre à l'agent. Cela donne
  l'isolation, un sous-compte virtuel par agent et un PnL attribuable.

### 2.2 Boucle de tick (`agents/engine.py`)

1. Résoudre le client API.
2. Exécuter les fournisseurs déterministes (executors et positions filtrés par agent).
3. Lire le journal : `learnings.md`, résumé, 3 dernières décisions.
4. Calculer l'**état de risque**. **Si l'agent est bloqué, le LLM n'est pas appelé.**
5. Construire le prompt.
6. Lancer la session LLM (claude-code, gemini… via ACP ; ou un fournisseur
   OpenAI-compatible / OpenRouter) avec les outils MCP.
7. Persister un **snapshot par tick** (prompt complet, réponse, appels d'outils)
   et le journal.

Modes : `dry_run` (un tick, **aucune capacité de trading**), `run_once` (un tick
avec trading) et `loop`.

### 2.3 Risque (`agents/risk.py`, `runtime/danger.py`)

- `RiskLimits` :
  - taille de position maximale ;
  - nombre maximal d'executors ouverts ;
  - drawdown « doux », qui met en pause ;
  - **drawdown de coupure**, qui déclenche un **déroulement d'urgence** des positions ;
  - écart comptable maximal (drift) ;
  - **levier maximal** ;
  - plafond de coût LLM.
- **Callback de permission** `auto_approve_with_risk_check` : **chaque appel
  d'outil du LLM est intercepté**. Les outils de lecture passent ; les outils de
  trading sont vérifiés contre les limites. « The agent literally cannot exceed
  its limits — the framework refuses on its behalf. »
- Liste des outils **dangereux** classée par nom (création d'executor, swap,
  liquidité…), en module sans dépendance pour éviter les effets de rechargement.
- Principe **fail-closed** : un livre comptable non fiable est une métrique
  manquante. Il **refuse toute nouvelle exposition mais laisse passer tous les
  freins** (réductions).
- **Espace de noms de propriété** : un agent ne peut pas toucher aux bots d'un autre.

### 2.4 Confirmation humaine (`runtime/confirmations.py`)

Les appels dangereux hors mode boucle attendent une **approbation humaine**,
avec **expiration = refus**. Les confirmations sont volontairement non
persistées : après un redémarrage, l'agent qui attendait n'existe plus.

### 2.5 Mémoire et réflexion

- Journal par session, snapshots par tick, `learnings.md` inter-sessions (20
  entrées maximum).
- Réflexion post-conversation exécutée **sans aucun outil** et avec toutes les
  permissions refusées. Les *playbooks* issus de la réflexion ne sont que
  **proposés** : un humain les accepte avant qu'ils n'atteignent un prompt.
- Chaque conversation n'est réfléchie **qu'une fois**, même en cas d'échec, pour
  éviter une fuite de tokens.

### 2.6 Mode explicite, jamais deviné

Le mode local (sans login) n'écoute que sur `127.0.0.1`, et le mode n'est
« jamais deviné » à partir de la présence d'un jeton. Une configuration
incohérente **arrête le démarrage**.

### 2.7 Sécurité

Avertissements forts : l'API contrôle des fonds réels, elle doit rester privée
(recommandation Tailscale), avec des mots de passe forts. Télémétrie anonyme avec
consentement.

---

## 3. Technologies

Hummingbot : Python, Cython, asyncio, aiohttp, Pydantic, Docker.
Condor : Python, FastAPI, WebSocket, python-telegram-bot, MCP, ACP,
**React 19 + Vite + lightweight-charts 5 + recharts** pour le frontend.

---

## 4. Composants intéressants

1. **Anatomie d'un connecteur** : auth, limites de débit, synchro d'horloge,
   règles de trading, suivi des ordres en vol et des ordres perdus, polling et WebSocket.
2. **Budget checker** : verrouillage du collatéral des ordres hypothétiques.
3. **Triple barrière** : stop, objectif, temps, suiveur, comme configuration de
   cycle de vie d'une position.
4. Séparation **couche déterministe / couche de raisonnement** (Condor).
5. **Le LLM agit via des actions contraintes**, jamais des ordres bruts.
6. **Interception de chaque action** par le risque, qui peut refuser.
7. **Pas d'appel LLM quand le risque bloque** : économie et sûreté.
8. **Drawdown doux (pause) et dur (déroulement)** : deux niveaux de kill switch.
9. **Fail-closed** : pas de nouvelle exposition si l'état est incertain ; les freins passent toujours.
10. **Modes dry_run / run_once / loop.**
11. **Snapshot complet par tick** : audit total.
12. **Plafond de coût LLM.**
13. **Confirmation humaine avec expiration = refus.**
14. **Mode explicite, jamais deviné.**

---

## 5. Limites

| Limite | Conséquence |
| --- | --- |
| Architecture serveur Python permanente (Docker, VPS, Tailscale) | Incompatible avec l'objectif GitHub → Cloudflare → iPhone sans serveur à maintenir |
| Interface principale Telegram | Hors de notre cible UX |
| Orienté crypto, market making, levier | Valeurs par défaut dangereuses pour un débutant |
| Agents via CLI d'IA (ACP) avec outils natifs | Surface d'attaque large ; non transposable à Workers |

---

## 6. Licences et réutilisation

Hummingbot **Apache-2.0**, Condor **MIT**. Réutilisation permise. Aucun code copié.

## 7. Ce que nous reprenons (adapté)

| Concept | Adaptation |
| --- | --- |
| Anatomie de connecteur | Interface `ExecutionVenue` et `MarketDataProvider` avec auth, limites de débit, règles de trading (quantums, minimum notionnel), identifiant client idempotent, suivi des ordres (V1) |
| Budget checker | Le Risk Engine raisonne sur l'exposition **incluant les ordres en attente** |
| Triple barrière | Chaque position porte `stopLoss`, `takeProfit` et `timeLimit` (horizon). Le moniteur les applique ; stop et limite de temps sortent au marché |
| Déterministe / raisonnement | Le moteur quantitatif calcule tout ; le LLM reçoit un snapshot et renvoie une proposition structurée |
| Actions contraintes | Le LLM ne produit qu'une `TradeProposal` validée par schéma ; il n'a **aucun outil** d'exécution |
| Interception par le risque | Le Durable Object `TradingDesk` fait passer **toute** proposition par le Risk Engine |
| Pas d'appel LLM si bloqué | Si l'état est `HALTED`, ou si le budget LLM ou les limites sont atteints, le cycle d'analyse n'appelle pas le LLM (mode `RESEARCH` : analyse seulement) |
| Drawdown doux et dur | `REDUCING` automatique sur perte journalière ; `HALTED` sur drawdown maximal |
| Fail-closed | Données périmées ou prix absent ⇒ refus de toute ouverture ; les réductions passent toujours |
| dry_run / run_once / loop | Analyse manuelle (run_once) ; cycle planifié (loop) ; mode RESEARCH (dry_run permanent) |
| Snapshot par tick | Chaque run d'analyse stocke les features, les prompts, les réponses brutes et le verdict |
| Plafond de coût LLM | Budget journalier en dollars, vérifié **avant** chaque appel |
| Expiration = refus | Toute confirmation sensible (passage de mode, levée du kill switch) expire |
| Mode explicite | Le mode est une donnée stockée et journalisée, jamais déduite |

## 8. Ce que nous ne reprenons pas

Les stratégies de market making, grid et arbitrage ; le levier par défaut ;
Telegram ; ACP et les CLI d'IA ; le serveur Python permanent.

## 9. Pertinence

- **Hummingbot : moyenne**, surtout pour l'anatomie des connecteurs du futur live (V1).
- **Condor : très élevée** pour la gouvernance de l'autonomie IA. C'est le dépôt
  le plus proche de notre exigence « le LLM ne doit jamais contourner le risque ».
