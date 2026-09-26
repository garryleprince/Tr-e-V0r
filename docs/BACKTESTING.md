# Backtesting — méthodologie

Statut : **architecture et fondations en V0.1** (plan de segments, moteur
événementiel, métriques, tous testés). **Interface et comparaison de stratégies
en V0.3.**

## 1. Principes

1. **Parité avec le paper trading** (NautilusTrader). Le backtest utilise le même
   `SimulatedExchange` (fills, frais, slippage), le même Portfolio Manager et le
   même Risk Engine que le paper trading. Une stratégie qui passe en backtest
   passe par exactement les mêmes contrôles.
2. **Exécution explicite à t+1** (Qlib, Nautilus). Un signal calculé à la
   clôture de la bougie *t* est exécuté à l'**ouverture de t+1**, plus le
   slippage. Jamais au prix de clôture qui a servi à décider.
3. **La stratégie ne voit que le passé.** Le moteur lui passe une vue de la
   fenêtre `candles[0..t]`. L'accès à `t+1` est structurellement impossible, et
   un test le vérifie.
4. **Coûts toujours inclus** : frais en points de base, frais minimum, slippage.
   Pas de résultat « hors coûts » par défaut.
5. **Métriques géométriques** (capital réel), pas arithmétiques.

## 2. Segments TRAIN / VALIDATION / TEST / OUT-OF-SAMPLE

```
|─── TRAIN ───|emb|── VALIDATION ──|emb|─── TEST ───|emb|── OUT-OF-SAMPLE ──|
  ajustement      sélection des        mesure unique     verrouillé : ouvert
  des paramètres  paramètres/modèles   de la perf.       une seule fois,
                                                          avant décision de prod
```

- Contrôles automatiques (`core/backtest/plan.ts`) : segments ordonnés, sans
  chevauchement, non vides, avec un **embargo** d'au moins *n* bougies entre deux
  segments (défaut : la plus longue fenêtre d'indicateur, 200). L'embargo évite
  qu'une bougie du segment suivant soit déjà dans la fenêtre de calcul.
- **TRAIN** : ajustement de tout ce qui est optimisable (seuils, périodes, poids).
- **VALIDATION** : choix entre variantes (le rôle du Sharpe de validation dans FinRL).
- **TEST** : une seule mesure par variante retenue. On ne revient pas ajuster
  après avoir vu TEST ; si on le fait, TEST devient de la validation et un
  nouveau TEST doit être défini.
- **OUT-OF-SAMPLE** : période la plus récente, **verrouillée**. Chaque ouverture
  est journalisée avec la configuration testée.

## 3. Biais évités

| Biais | Mesure |
| --- | --- |
| **Look-ahead** | Bougies fermées uniquement ; horodatage à la clôture ; exécution à t+1 ; vue tronquée passée à la stratégie ; test automatique d'inviolabilité |
| **Data leakage** | Normalisations et paramètres ajustés sur TRAIN seulement ; embargo entre segments ; leçons de mémoire filtrées point-in-time (TradingAgents #1251) |
| **Survivorship** | Univers **défini à la date** de chaque segment. Les instruments retirés restent en base (`instruments.active = 0`, jamais supprimés). **Limite connue** : les API gratuites ne fournissent pas l'historique des composants d'indices ; tout backtest d'actions sur un « top N actuel » sera marqué comme potentiellement biaisé |
| **Overfitting** | Nombre de variantes testées enregistré avec chaque résultat ; TEST unique ; walk-forward (V0.3) ; comparaison obligatoire avec les références simples (acheter et conserver, agent à règles) ; OOS verrouillé |
| **Stop et objectif dans la même bougie** | Le stop est réputé touché d'abord (hypothèse pessimiste, documentée) |
| **Backtest d'un LLM** | Les sorties LLM ne sont pas reproductibles et les flux d'actualité ne sont pas archivés (TradingAgents le reconnaît). Les backtests LLM seront marqués **indicatifs**. Le backtest déterministe porte sur les agents à règles et les modèles figés |

## 4. Métriques (`core/backtest/metrics.ts`)

Rendement total, CAGR, volatilité annualisée, Sharpe (taux sans risque
configurable, 0 par défaut), Sortino, drawdown maximal et durée, Calmar, nombre
de trades, taux de réussite, gain moyen, perte moyenne, profit factor, espérance
par trade, exposition moyenne, performances par mois.

Les mêmes fonctions calculent les statistiques du **paper trading** dans l'écran
Portefeuille : une seule définition pour toutes les mesures.

## 5. Évolutions

- **V0.3** : écran Backtest (actif, période, stratégie, paramètres, segments),
  comparaison de plusieurs stratégies, walk-forward, courbes d'equity et de
  drawdown superposées, performances par période, enregistrement des runs avec
  le hash de leur configuration (Recorder de Qlib).
- **V0.3** : IC et Rank IC des signaux d'agents (Qlib), pour mesurer leur
  qualité prédictive indépendamment de la stratégie.
- **V1+** : labo hors ligne (Python, Qlib ou Nautilus) branché derrière
  l'interface `BacktestEngine` pour les études lourdes.
