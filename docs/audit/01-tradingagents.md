# Fiche 1 — TradingAgents (TauricResearch)

| | |
| --- | --- |
| Dépôt | https://github.com/TauricResearch/TradingAgents |
| Version analysée | `v0.5.1`, commit `35543d0` (24 septembre 2026) |
| Licence | **Apache-2.0** (fichier `LICENSE` vérifié) |
| Langage | Python ≥ 3.10, LangGraph, LangChain |
| Taille | ~8 100 lignes de code applicatif, ~100 fichiers de tests |
| Statut | Outil de **recherche**, explicitement « not intended as financial advice » |

Dépôt prioritaire pour l'architecture IA. C'est aussi celui qui a demandé le plus
de lecture de code : graphe, agents, schémas, mémoire, backtest, clients LLM.

---

## 1. Objectif

Reproduire le fonctionnement d'une société de trading avec des agents LLM
spécialisés qui analysent un titre à une date donnée, en débattent et produisent
une **note** finale sur cinq niveaux (Buy / Overweight / Hold / Underweight / Sell).

Le système **ne passe aucun ordre**. Il n'a ni carnet d'ordres, ni portefeuille
simulé, ni exécution. Son `backtest.py` le dit lui-même : il évalue la *qualité
des décisions*, pas un portefeuille (« It is not a portfolio simulator, and must
not grow one »).

---

## 2. Architecture

### 2.1 Le graphe (`graph/setup.py`)

Un `StateGraph` LangGraph linéaire en quatre étages :

```
START
  │
  ▼
Analystes (séquentiels, chacun avec sa boucle d'outils)
  Market ──► Sentiment ──► News ──► Fundamentals
  │   (après chaque analyste : nœud « Msg Clear » qui vide l'historique)
  ▼
Débat de recherche : Bull ⇄ Bear  (2 × max_debate_rounds tours)
  ▼
Research Manager (modèle « deep ») ──► plan d'investissement structuré
  ▼
Trader (modèle « quick ») ──► proposition structurée (action, entrée, stop, taille)
  ▼
Débat de risque : Aggressive ⇄ Conservative ⇄ Neutral  (3 × max_risk_discuss_rounds)
  ▼
Portfolio Manager (modèle « deep ») ──► note finale structurée
  ▼
END
```

Les transitions du débat sont décidées par `ConditionalLogic` à partir d'un
compteur et du dernier orateur. Les tables de routage (`DEBATE_PATH_MAP`,
`RISK_ANALYSIS_PATH_MAP`) couvrent toutes les cibles possibles, pour qu'une dérive
de libellé ne fasse pas planter le graphe en cours de route (ticket #1088).

### 2.2 Communication entre agents

Les agents communiquent par un **état partagé** (`AgentState`, un `TypedDict`) :
`market_report`, `sentiment_report`, `news_report`, `fundamentals_report`,
`investment_debate_state`, `trader_investment_plan`, `risk_debate_state`,
`final_trade_decision`…

Tous ces champs sont de la **prose**. Chaque débatteur reçoit tous les rapports
complets plus l'historique entier du débat. C'est lisible, mais le volume de
tokens croît vite, et une erreur d'un analyste se propage à tous les agents en aval.

### 2.3 Les agents

| Agent | Fichier | Modèle | Sortie |
| --- | --- | --- | --- |
| Market (technique) | `analysts/market_analyst.py` | quick | prose + tableau ; outils `get_stock_data`, `get_indicators`, `get_verified_market_snapshot` |
| Sentiment | `analysts/sentiment_analyst.py` | quick | `SentimentReport` structuré (bande, score 0–10, confiance, récit) |
| News | `analysts/news_analyst.py` | quick | prose, outils news + macro (FRED) |
| Fundamentals | `analysts/fundamentals_analyst.py` | quick | prose, états financiers (SEC EDGAR, yfinance, Alpha Vantage) |
| Bull / Bear | `researchers/*.py` | quick | argumentaire en prose |
| Research Manager | `managers/research_manager.py` | deep | `ResearchPlan` structuré |
| Trader | `trader/trader.py` | quick | `TraderProposal` structuré : action, raisonnement, entrée, stop, taille |
| Aggressive / Conservative / Neutral | `risk_mgmt/*.py` | quick | argumentaire en prose |
| Portfolio Manager | `managers/portfolio_manager.py` | deep | `PortfolioDecision` structuré : note, résumé, thèse, objectif, horizon |

**Point essentiel :** la « gestion du risque » est un **débat entre LLM**. Aucune
limite chiffrée n'est imposée par du code : ni risque par trade, ni exposition
maximale, ni drawdown. C'est le Portfolio Manager, un LLM, qui « approuve ».

### 2.4 Sorties structurées (`agents/schemas.py`, `agents/structured.py`)

- Les trois agents de décision utilisent `with_structured_output(Schema)` : tool
  use côté Anthropic, `json_schema` côté OpenAI, `response_schema` côté Gemini.
- En cas d'échec, repli sur une génération en texte libre (`invoke_structured_or_freetext`).
- Les champs numériques écrits par un LLM sont assainis (`_coerce_optional_float`).
  « 15 % » est rejeté plutôt qu'interprété comme un prix, « $1,234.50 » est converti,
  et une fourchette (« 150-160 ») devient nulle.
- **Sentinelle `REVIEW`** (`rating.py`) : une décision sans note lisible devient
  `REVIEW`, jamais `Hold`. Un Hold inventé serait relu plus tard comme une décision
  réellement prise.

### 2.5 Mémoire (`decision_log.py`, `graph/settlement.py`, `graph/reflection.py`)

Mémoire en deux phases, dans un journal markdown en ajout seul :

1. **Phase A** : à la fin d'une analyse, la décision est écrite avec l'étiquette `pending`.
2. **Phase B** : au prochain passage sur le même ticker, les décisions dont la
   fenêtre de détention (5 jours par défaut) est écoulée sont réglées. Le système
   calcule le rendement brut et l'alpha contre un indice régional (SPY, ^N225…),
   puis un LLM écrit une réflexion de 2 à 4 phrases.
3. Les leçons sont réinjectées dans le prompt du Portfolio Manager : 5 décisions
   récentes sur le même ticker, 3 leçons sur d'autres tickers.
4. **Filtre point-in-time** : dans un run historique, seules les leçons connues à
   la date de l'analyse sont injectées (`resolved:YYYY-MM-DD`, ticket #1251).

### 2.6 Intégrité temporelle (anti look-ahead)

C'est le travail le plus mûr du dépôt :

- `date_window.as_of()` borne toute date demandée par le LLM à la date du run :
  le modèle ne peut pas « demander demain ».
- `as_of_window()` recale une fenêtre qui dépasserait la date du run.
- `withhold_live_profile()` retient les profils d'entreprise qui n'ont pas de
  version historique (capitalisation, multiples, secteur) dans un run daté dans le passé.
- SEC EDGAR sert les chiffres **tels que déposés** à la date : un bilan retraité
  plus tard garde sa valeur d'origine.
- `coverage_gap()` : un flux qui ne sert que des données récentes ne peut pas
  prétendre à une « absence de nouvelles » sur une fenêtre passée.
- `report_or_absent()` : un rapport manquant est présenté comme *absent*, pas
  comme *vide*, pour que l'agent suivant ne comble pas le trou en inventant.

### 2.7 Ancrage anti-hallucination

- **Identité de l'instrument** résolue de façon déterministe avant tout LLM
  (`resolve_instrument_identity`, #814). Sans cela, l'analyste « reconnaissait »
  parfois une autre entreprise à partir du graphique.
- **Snapshot de marché vérifié** (`get_verified_market_snapshot`) : c'est la seule
  source de vérité pour tout chiffre précis (OHLCV, RSI, MACD). En cas de
  contradiction, l'agent doit la signaler plutôt que réconcilier.
- Le Trader ancre ses niveaux (entrée, stop) sur l'ATR et les supports du rapport
  technique (#1167).

### 2.8 Couche LLM (`llm_clients/`)

- `factory.create_llm_client(provider, model)` : Anthropic, Google, Azure,
  Bedrock en natif. Tout le reste passe par un client « OpenAI-compatible » :
  OpenAI, xAI, DeepSeek, Qwen, GLM, MiniMax, OpenRouter, Mistral, Groq, NVIDIA,
  Ollama, vLLM…
- **Deux niveaux de modèle** : `deep_think_llm` (managers) et `quick_think_llm`
  (analystes, débatteurs, trader).
- **Table de capacités par modèle** (`capabilities.py`) : quelles options chaque
  modèle accepte (tool_choice, json_schema, round-trip du raisonnement). On ajoute
  un modèle en éditant la table, pas le code.
- Anthropic : `effort` transmis seulement aux modèles qui l'acceptent ; le contenu
  en blocs est normalisé en texte.
- Budget de réessais et `max_tokens` configurables et validés au démarrage.

### 2.9 Backtest (`backtest.py`)

Grille ticker × dates. Chaque cellule lance le graphe complet, écrit dans un
journal propre au run, puis règle les décisions. Le résumé par note donne le
nombre de décisions, le taux de bonne direction et l'alpha moyen. Le README le
reconnaît : un seul échantillonnage par cellule et des flux de news non archivés,
donc les chiffres sont indicatifs et non reproductibles.

### 2.10 Qualité logicielle

- Environ 100 fichiers de tests, CI sur Python 3.10 à 3.13, dont un job hors UTC
  (`TZ=America/New_York`) pour attraper les tests qui ne passent qu'en UTC.
- `test_layering.py` : seul le module `dataflows` a le droit d'importer les
  bibliothèques des fournisseurs (yfinance). Une panne de fournisseur ne peut donc
  pas être rapportée comme un fait de marché.
- Reprise sur point de contrôle LangGraph (SQLite), invalidée si la forme du graphe change.

---

## 3. Technologies

Python, LangGraph (`StateGraph`, `ToolNode`), LangChain (`with_structured_output`,
`bind_tools`), pandas, stockstats, yfinance, requests, Typer et Rich pour la CLI,
SQLite pour les points de contrôle, Docker.

---

## 4. Composants et fonctionnalités intéressants

1. La **décomposition des rôles** : analystes → chercheurs → trader → risque → gérant.
2. Les **sorties structurées** limitées aux agents qui décident, avec des schémas
   dont les descriptions de champs servent d'instructions.
3. La sentinelle **REVIEW plutôt que HOLD**.
4. `report_or_absent` et le marqueur d'ouverture de débat (#1176) : ne jamais
   laisser un LLM combler un vide.
5. **Snapshot vérifié** et **identité déterministe** : les chiffres viennent du
   code, pas du modèle.
6. **Garde-fous point-in-time** systématiques (`as_of`, fenêtres, profils retenus).
7. **Mémoire à règlement différé** et filtre de leçons point-in-time.
8. Évaluation des décisions **par note** (taux de bonne direction, alpha moyen).
9. Usine de fournisseurs LLM, **table de capacités**, niveaux deep/quick.
10. Test de **cloisonnement** des bibliothèques fournisseurs.

---

## 5. Limites

| Limite | Conséquence pour nous |
| --- | --- |
| Risque géré par débat LLM, sans aucune limite dure | Inacceptable comme Risk Manager : un LLM peut toujours « se convaincre » |
| Environ 12 à 20 appels LLM par ticker et par date (4 analystes avec boucles d'outils, 2N débat, RM, trader, 3M risque, PM) | Coût et latence élevés pour un usage quotidien sur plusieurs actifs |
| État en prose transmis intégralement | Tokens en croissance, erreurs propagées |
| Aucune exécution, aucun portefeuille simulé | À construire entièrement |
| Non-déterminisme assumé (échantillonnage, flux non archivés) | Les backtests LLM sont indicatifs, pas reproductibles |
| Dépendance à yfinance (API non officielle) | Fragile, conditions d'utilisation incertaines |
| Python et LangGraph | Ne s'exécute pas sur Cloudflare Workers |

---

## 6. Licence et réutilisation

**Apache-2.0** : réutilisation du code permise, avec conservation de la licence et
des notices et mention des modifications. Nous ne copions **aucun code ni aucun
prompt** : le runtime est différent (TypeScript sur Workers) et nos prompts sont
écrits pour nos propres contrats de données. Nous reprenons des **concepts**, qui
sont cités dans `THIRD_PARTY_NOTICES.md`.

---

## 7. Ce que nous reprenons (adapté)

| Concept | Adaptation dans notre application |
| --- | --- |
| Rôles spécialisés | Agents Technique, Fondamental, Sentiment, Macro, Trader. Portfolio Manager **déterministe** |
| Sorties structurées sur les agents de décision | **Toutes** les sorties d'agent sont des objets validés par zod ; pas de repli texte libre pour une décision |
| REVIEW ≠ HOLD | Une sortie invalide produit une décision `INVALIDE`, jamais un HOLD |
| `report_or_absent` | Chaque rapport porte un statut `ok` / `indisponible` / `erreur` ; l'agent suivant voit l'absence explicitement |
| Snapshot vérifié | Le moteur quantitatif calcule tous les chiffres ; le LLM ne fait que les interpréter. Les niveaux proposés sont re-vérifiés par le Risk Engine (bande de prix) |
| `as_of` | Toute analyse porte un `asOf` = clôture de la dernière bougie **fermée** ; aucune donnée postérieure n'est accessible |
| Mémoire à règlement différé | Journal des décisions en base, règlement à l'horizon annoncé, MFE/MAE, étiquetage des erreurs |
| Filtre point-in-time des leçons | Aucune leçon réinjectée sans filtre de date **et** sans validation hors échantillon |
| Deep / quick | Deux niveaux configurables par fournisseur |
| Table de capacités | Capacités déclarées par fournisseur et modèle |
| Test de cloisonnement | Test : seuls les adaptateurs de `server/data` et `server/llm` font des appels réseau |

## 8. Ce que nous ne reprenons pas

- Le **débat de risque LLM comme autorité** : il pourra exister (V0.2+) comme
  *avis* consultatif, jamais comme contrôle.
- La transmission intégrale de la prose entre agents.
- Le repli en texte libre pour une décision.
- yfinance.
- LangGraph Python comme runtime.

## 9. Pertinence

**Très élevée pour la couche IA** (rôles, contrats, garde-fous temporels,
mémoire). **Nulle pour l'exécution et le risque quantitatif**, qu'il faut prendre ailleurs.
