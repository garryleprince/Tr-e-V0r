# Fiche 2 — Qlib (Microsoft)

| | |
| --- | --- |
| Dépôt | https://github.com/microsoft/qlib |
| Commit analysé | `be72549` (16 septembre 2026) |
| Licence | **MIT** (fichier `LICENSE` vérifié) |
| Langage | Python, Cython pour les opérateurs, MLflow pour les expériences |
| Positionnement | Plateforme de recherche quantitative orientée IA, de l'idée à la production |

---

## 1. Objectif

Couvrir toute la chaîne quantitative : données → features (alphas) → modèle
prédictif → stratégie de portefeuille → simulation d'exécution → analyse.
Le cadre est surtout **cross-sectionnel** : classer des centaines d'actions chaque
jour, par exemple le CSI300 ou le S&P 500.

---

## 2. Architecture

Des modules faiblement couplés, utilisables séparément :

```
Data layer ─────► DataHandler (processors) ─────► DatasetH (segments)
  │ calendrier, instruments,        │ fit sur la période d'entraînement
  │ moteur d'expressions ($close,   │ seulement (ZScoreNorm, RobustZScoreNorm…)
  │ Ref, Mean, Std, Corr…), PIT     ▼
  ▼                              Model (LGBModel, zoo de ~30 modèles)
Cache / serveur de données          ▼
                                 Signal ──► Strategy (TopkDropout, EnhancedIndexing)
                                               ▼
                                 Executor (imbriquable) ──► Exchange simulé
                                               ▼
                                 Records : SignalRecord, SigAnaRecord (IC),
                                 PortAnaRecord (backtest) ──► Recorder (MLflow)
```

### 2.1 Données et features

- **Moteur d'expressions** : une feature s'écrit comme une formule
  (`Ref($close, -2)/Ref($close, -1) - 1`) et est calculée par le moteur avec cache.
- **Alpha158 / Alpha360** : bibliothèques de features prêtes à l'emploi. Barres
  (KMID, KLEN…), ROC, MA, STD, BETA, RSQR, RESI, QTLU, RSV, CORR, CNTP, SUMP, VMA,
  WVMA, VSUMP…, sur plusieurs fenêtres (5, 10, 20, 30, 60).
- **Point-in-time** (`data/pit.py`) : les données fondamentales sont stockées en
  `<observe_time, period_time, valeur>`. L'opérateur `P` refuse toute référence à
  une période future (`ValueError` si `end_ws > 0`).
- **Label** explicite : `Ref($close, -2)/Ref($close, -1) - 1`. On prédit le
  rendement du lendemain au surlendemain, parce que le signal calculé à la clôture
  de *t* ne peut être exécuté qu'en *t+1*. Le décalage d'exécution est donc dans le label.

### 2.2 Prévention des fuites

- `DataHandlerLP` sépare les processeurs `learn` et `infer`, avec des fenêtres
  `fit_start_time` / `fit_end_time`. Les normalisations sont ajustées sur
  l'entraînement **uniquement**.
- `DatasetH.segments` : `train` / `valid` / `test` explicites dans la config
  (exemple LightGBM : 2008–2014 / 2015–2016 / 2017–2020).
- `RollingGen` et `trunc_segments` pour le réentraînement glissant (walk-forward),
  qui tronquent les segments « to avoid the leakage of future information ».
- `DDG-DA` : adaptation à la dérive de distribution (recherche).

### 2.3 Backtest (`qlib/backtest/`)

- `Exchange` : prix d'exécution configurable (`$close`, `$open`, `$vwap`, ou un
  prix différent à l'achat et à la vente), coûts d'ouverture et de clôture, coût
  minimum, **coût d'impact** (slippage), seuil de limite de prix (limit up/down),
  seuils de volume (participation au volume cumulé), unité de négociation
  (100 actions en Chine), suspension si `$close` manquant.
- `Account`, `Position`, `Order`, `TradeDecision`, `Executor` : les exécuteurs
  sont **imbriquables**, par exemple une stratégie journalière qui délègue à un
  exécuteur minute.
- Analyse : `risk_analysis()` calcule la moyenne, l'écart-type, le rendement
  annualisé, le ratio d'information et le drawdown maximal, en mode `sum` (par
  défaut, arithmétique) ou `product` (géométrique).
- Indicateurs d'exécution : PA (price advantage), POS, FFR (taux de remplissage).

### 2.4 Évaluation des signaux

`SigAnaRecord` calcule l'**IC**, l'**ICIR**, le **Rank IC** et le **Rank ICIR**,
ainsi que les rendements long-short par groupes. On évalue ainsi la qualité
prédictive d'un signal **indépendamment** de la stratégie de portefeuille.

### 2.5 Portefeuille et risque

- `TopkDropoutStrategy` : détenir les *k* meilleurs et remplacer au plus *n* par
  période, pour limiter la rotation.
- `EnhancedIndexingOptimizer` : optimisation sous contraintes de tracking error.
- `model/riskmodel` : estimateurs de covariance (shrinkage Ledoit-Wolf, POET,
  modèles factoriels structurés PCA/FA).

### 2.6 Reinforcement learning (`qlib/rl/`)

Uniquement pour l'**exécution d'ordres** : découper un gros ordre sur la journée
(TWAP, PPO, OPDS). Récompense `PAPenaltyReward` = avantage de prix − pénalité de
concentration du volume. C'est un cas d'usage **institutionnel** : il sert quand
l'ordre est assez gros pour faire bouger le prix.

### 2.7 Industrialisation

`qrun` pilote un workflow YAML complet. Recorder MLflow (expériences, artefacts,
métriques), service en ligne avec réentraînement automatique, serveur de données
partagé. RD-Agent, un projet séparé, automatise la R&D de facteurs avec des LLM.

---

## 3. Technologies

Python, NumPy, pandas, Cython, LightGBM, PyTorch, scikit-learn, MLflow, Gym/Tianshou
pour la RL, stockage binaire maison.

---

## 4. Composants et fonctionnalités intéressants

1. **Segments train / valid / test déclaratifs** et normalisation ajustée sur l'entraînement seul.
2. **Label avec décalage d'exécution explicite.**
3. **Walk-forward** (`RollingGen`) avec troncature anti-fuite.
4. **Point-in-time** pour les fondamentaux.
5. **Évaluation du signal (IC / Rank IC)** séparée de l'évaluation du portefeuille.
6. **Modèle de coûts** complet : ouverture, clôture, minimum, impact, volume.
7. Distinction **sum vs product** dans les métriques, explicitement documentée.
8. **Recorder** : chaque run est une expérience versionnée, avec config et artefacts.

---

## 5. Limites

| Limite | Conséquence pour nous |
| --- | --- |
| Pensé pour des univers de centaines d'actions en cross-section | Nous suivons quelques actifs : une grande partie ne s'applique pas |
| Infrastructure de données lourde (format binaire, téléchargements, cache) | Inadaptée à Workers ; utile seulement dans un « labo » Python hors ligne |
| Conventions orientées marché chinois dans les exemples (limite 9,5 %, lot de 100) | À ne pas transposer |
| Annualisation par défaut en mode `sum` | Nous utiliserons le mode géométrique, plus conforme au capital réel |
| Pas d'exécution réelle | Hors de son périmètre |
| Pas de LLM dans le cœur | RD-Agent est un projet distinct |

---

## 6. Licence et réutilisation

**MIT** : réutilisation libre, avec conservation de la notice de copyright.
Nous ne réutilisons pas de code : le Python n'est pas portable sur Workers et le
format de données ne nous sert pas. Les **définitions mathématiques** des
features et des métriques sont standard et réimplémentées en TypeScript.

## 7. Ce que nous reprenons (adapté)

| Concept | Adaptation |
| --- | --- |
| Segments train / valid / test | `BacktestPlan` avec **quatre** segments (TRAIN / VALIDATION / TEST / OUT-OF-SAMPLE), contrôlés : ordonnés, sans chevauchement, avec **embargo** entre segments |
| Fit sur l'entraînement uniquement | Tout paramètre optimisé (seuils, périodes) est choisi sur TRAIN+VALIDATION ; TEST ne sert qu'une fois ; OOS est verrouillé |
| Label décalé | Signal à la clôture de *t*, exécution à l'**ouverture de t+1** dans le backtest |
| Walk-forward | Réoptimisation glissante (V0.3) |
| IC / Rank IC | Mesure de la qualité prédictive des signaux des agents (V0.3) |
| Modèle de coûts | `CostModel` : frais en bps, frais minimum, slippage en bps, participation au volume maximale |
| Métriques | Rendement, CAGR (géométrique), volatilité, Sharpe, Sortino, drawdown max, Calmar, profit factor, espérance |
| Recorder | Chaque backtest est enregistré avec le **hash de sa configuration** et la version du code |
| Features | Bibliothèque de features TypeScript inspirée d'Alpha158 : ROC, MA, STD, RSV, CORR, volumes… |

## 8. Ce que nous ne reprenons pas

L'infrastructure de données, le zoo de modèles, la RL d'exécution (sans objet à
notre taille d'ordres), les optimiseurs cross-sectionnels (V1+ seulement si
l'univers grandit) et MLflow.

## 9. Pertinence

**Élevée comme méthode** : protocole de validation, anti-fuite, métriques, coûts.
**Faible comme composant logiciel** intégré.
