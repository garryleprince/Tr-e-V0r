# Fiche 4 — FinRL et FinRL-X / FinRL-Trading (AI4Finance Foundation)

| | FinRL | FinRL-X (FinRL-Trading) |
| --- | --- | --- |
| Dépôt | https://github.com/AI4Finance-Foundation/FinRL | https://github.com/AI4Finance-Foundation/FinRL-Trading |
| Commit analysé | `adde5da` (26 sept. 2026) | `4409abe` (18 sept. 2026) |
| Licence | **MIT** (vérifiée) | **Apache-2.0** (vérifiée) |
| Positionnement | Cadre éducatif et de recherche en RL financier | Infrastructure « AI-native » orientée production |

Le README de FinRL renvoie désormais vers FinRL-X pour tout usage moderne ou de
production. Nous avons donc analysé les deux.

---

## 1. FinRL : objectif et architecture

Trois couches :

1. **Environnements de marché** au format Gym. `StockTradingEnv`,
   variantes cash-penalty et stop-loss, portefeuille, crypto, paper trading.
2. **Agents DRL** : Stable-Baselines3 (A2C, PPO, DDPG, TD3, SAC, TQC, CrossQ),
   ElegantRL, RLlib, FastTD3.
3. **Applications** : trading d'actions, ensemble, fenêtre glissante, allocation.

### 1.1 L'environnement (`env_stocktrading.py`)

- **État** : cash + prix + positions + indicateurs, par actif. La taille est
  `1 + 2·N + K·N`.
- **Action** : vecteur continu dans [-1, 1] × `hmax` (nombre d'actions à
  acheter ou vendre par actif).
- **Récompense** : variation de la valeur du portefeuille
  (`end_total_asset - begin_total_asset`) × `reward_scaling`. Récompense
  **brute en P&L**, sans ajustement au risque.
- **Coûts** : pourcentage fixe à l'achat et à la vente.
- **Turbulence** : au-delà d'un seuil (turbulence de Kritzman ou VIX), toutes les
  positions sont **liquidées** et les achats bloqués.

### 1.2 Entraînement et validation

- Découpage par dates : `TRAIN_START/END`, `TEST_START/END`, `TRADE_START/END`
  (`config.py`).
- **Stratégie d'ensemble** (`DRLEnsembleAgent`) : sur des fenêtres glissantes, on
  entraîne A2C, PPO et DDPG, puis on choisit pour la fenêtre suivante celui dont
  le **Sharpe de validation** est le meilleur.
- Features : 8 indicateurs stockstats (MACD, Bollinger, RSI30, CCI30, DX30, SMA30/60) + turbulence.

---

## 2. FinRL-X : objectif et architecture

Architecture **centrée sur les poids** : le vecteur de poids cible est l'**unique
contrat** entre la stratégie et l'exécution.

```
w_t = R_t( T_t( A_t( S_t( X_≤t ) ) ) )
S = sélection d'actifs, A = allocation, T = timing, R = overlay de risque
```

Chaque transformation préserve le contrat. On peut remplacer l'allocation
équipondérée par un allocateur DRL sans toucher au reste, et **les mêmes poids**
passent en backtest et en live.

| Couche | Contenu |
| --- | --- |
| Data | Yahoo → FMP → WRDS en sélection automatique, prétraitement de sentiment par LLM, cache SQLite |
| Strategy | Sélection ML (Random Forest), allocation (équipondérée, mean-variance, min-variance, DRL), timing (KAMA), overlay de risque |
| Backtest | Bibliothèque `bt`, comparaison multi-benchmarks, coûts |
| Execution | Alpaca multi-comptes, contrôles pré-trade |
| Config | Pydantic + `.env` multi-environnements |
| Web | **Streamlit + Plotly** (`src/web/app.py`) |

### 2.1 Stratégie « Adaptive Rotation » (`strategies/adaptive_rotation/`)

- **Walk-forward** strict (`walk_forward.py`) : chaque point de décision ne voit
  que les données antérieures.
- **Régime de marché à deux vitesses** (`market_regime.py`) : un régime lent
  hebdomadaire (tendance 26 semaines, drawdown 13 semaines, z-score du VIX) et un
  risk-off rapide quotidien (choc sur 3 jours). Le régime pilote le **budget de
  risque**, pas la sélection.
- **Risk manager** (`risk_manager.py`) : stop absolu, stop suiveur depuis le plus
  haut, **période de refroidissement** après un stop.
- Contrôles d'exécution (`trade_executor.py`) : valeur maximale par ordre,
  **rotation maximale par rééquilibrage** (les ordres sont réduits à l'échelle si
  elle est dépassée), `dry_run`.

### 2.2 Résultats publiés

Backtest 2018–2025 : Sharpe 0,93 à 1,10. Paper trading d'octobre 2025 à mars
2026 : +19,8 %, Sharpe 1,96. **À lire avec prudence** : période courte, choix de
la stratégie a posteriori, univers survivant (NASDAQ-100 actuel).

---

## 3. Technologies

Python, Gymnasium, Stable-Baselines3, PyTorch, ElegantRL, pandas, stockstats,
`bt`, alpaca-py, Pydantic, Streamlit, Plotly, SQLite, Docker.

---

## 4. Composants intéressants

1. FinRL-X : **contrat par poids cibles** entre stratégie et exécution.
2. **Overlay de risque** séparé de la sélection ; le régime module le budget de risque.
3. **Stop suiveur et refroidissement** après stop.
4. **Rotation maximale** par rééquilibrage.
5. **Walk-forward** point-in-time.
6. FinRL : **sélection de modèle par Sharpe de validation** sur fenêtres glissantes.
7. Principe de **turbulence** (risque systémique) comme coupe-circuit.

---

## 5. Limites

| Limite | Détail |
| --- | --- |
| Récompense RL = P&L brut | Pousse à la prise de risque ; pas de pénalité de drawdown ni de volatilité |
| Espace d'état et d'action simpliste | `hmax` fixe, pas de modélisation du slippage dépendant du volume |
| Petits univers (Dow 30) et fenêtres courtes | Risque très élevé de **sur-apprentissage** ; une RL avec peu d'épisodes indépendants ne généralise pas |
| Non-stationnarité des marchés | Une politique apprise sur 2014–2025 n'a aucune garantie en 2026 |
| Liquidation totale par turbulence | Mécanisme binaire, coûteux |
| `is_paper` déduit de la présence de « paper » dans l'URL (`alpaca_manager.py`) | **Fragile et dangereux** : le mode doit être explicite |
| Interface Streamlit | Exactement le « dashboard Python » que nous voulons éviter |
| Survivorship bias dans les résultats publiés | Univers définis avec la composition actuelle |

---

## 6. Question clé : le reinforcement learning apporte-t-il de la valeur ici ?

**Réponse argumentée : pas maintenant, et peut-être jamais pour la décision de
direction. Éventuellement, plus tard, pour le dimensionnement, sous conditions strictes.**

1. **Données insuffisantes.** En barres journalières sur quelques actifs, on a
   environ 250 observations par an et par actif. Une politique RL a besoin de
   beaucoup d'épisodes *indépendants*. Rejouer le même historique n'en crée pas
   de nouveaux.
2. **Simulateur trop pauvre.** Notre simulateur ne modélise pas l'impact de nos
   ordres. Une RL exploiterait ses défauts plutôt que le marché.
3. **Des bases simples sont difficiles à battre.** Risque fixe par trade, ciblage
   de volatilité, suivi de tendance avec stop ATR. Toute approche apprise doit les
   battre **hors échantillon, net de coûts**.
4. **Opacité.** Une politique RL n'explique pas ses décisions, ce qui contredit
   l'exigence de journal explicable et d'analyse d'erreurs.
5. **Le LLM ne doit pas contourner le risque.** C'est aussi vrai pour une
   politique RL : elle ne pourra que *proposer*, comme tout le reste.

**Ce que nous prévoyons à la place :**

- une interface `SizingPolicy` (dimensionnement), avec des implémentations
  déterministes (risque fixe, ciblage de volatilité) ;
- un **« labo de recherche » Python hors ligne** (V1+) où une politique RL ou ML
  peut être entraînée. Elle ne sera branchée qu'après avoir battu les bases sur
  TEST puis OUT-OF-SAMPLE, avec un rapport de validation archivé ;
- la RL reste **désactivée par défaut**. Aucune implémentation RL n'est écrite
  tant que ces conditions ne sont pas réunies.

---

## 7. Licences et réutilisation

FinRL : **MIT**. FinRL-X : **Apache-2.0**. Réutilisation permise avec notices.
Aucun code repris : Python non portable, et les composants RL sont exclus pour
l'instant.

## 8. Ce que nous reprenons (adapté)

| Concept | Adaptation |
| --- | --- |
| Contrat par poids ou exposition cible | Le Portfolio Manager traduit une proposition en **exposition cible** ; le Risk Engine la réduit ou la refuse ; l'Execution Engine la réalise. Les maillons sont remplaçables |
| Overlay de régime | Le régime (tendance, volatilité) module le **budget de risque** (V0.2) |
| Stop suiveur et refroidissement | Refroidissement après N pertes consécutives (V0.1 : règle de risque) ; stop suiveur (V0.4) |
| Rotation maximale | Limite de nouveaux ordres par jour |
| Sélection par validation | Choix de stratégie ou paramètres sur VALIDATION uniquement, jamais sur TEST |
| Mode explicite | Mode `RESEARCH` / `PAPER` / `LIVE` **stocké**, jamais déduit d'une URL ou d'une clé |

## 9. Ce que nous ne reprenons pas

Les agents RL (pour l'instant), la récompense en P&L brut, la liquidation binaire
par turbulence, Streamlit et la détection implicite du mode paper.

## 10. Pertinence

**Moyenne.** Les idées de FinRL-X sur le contrat de poids et l'overlay de risque
sont utiles. La RL n'apporte pas de valeur démontrable dans notre cadre actuel.
