# Synthèse comparative des cinq dépôts

Ce document répond à une seule question :

> **Comment construire UNE application de trading IA en utilisant les meilleures
> idées de ces projets ?**

Les fiches détaillées sont dans ce dossier :
[TradingAgents](01-tradingagents.md) · [Qlib](02-qlib.md) ·
[NautilusTrader](03-nautilustrader.md) · [FinRL / FinRL-X](04-finrl.md) ·
[Hummingbot / Condor](05-hummingbot-condor.md).

Méthode : clonage de chaque dépôt, lecture du code source (pas seulement des
README) et vérification des licences sur les fichiers `LICENSE`. Commits
analysés : entre le 16 et le 26 septembre 2026.

---

## 1. Matrice

Échelle : ●●● couverture forte, ●● partielle, ● marginale, — absente.

| Fonction | TradingAgents | Qlib | NautilusTrader | FinRL (+X) | Hummingbot (+Condor) |
| --- | --- | --- | --- | --- | --- |
| **Agents IA** | ●●● 12 rôles LLM, débats | ● (RD-Agent séparé) | — (hors périmètre) | ● agents RL | ●● Condor : agents LLM à tick |
| **LLM** | ●●● 15+ fournisseurs, sorties structurées, capacités par modèle | — | — | ● sentiment LLM (X) | ●● ACP, OpenRouter, OpenAI-compatible |
| **Analyse technique** | ●● indicateurs via outils + snapshot vérifié | ●●● Alpha158/360, moteur d'expressions | ●● indicateurs Rust | ● 8 indicateurs | ● bougies, contrôleurs |
| **Analyse fondamentale** | ●●● SEC EDGAR « as filed », yfinance, AV | ● base point-in-time | — | ●● sélection ML (X) | — |
| **Sentiment** | ●● news, StockTwits, Reddit, filtrage | — | — | ● prétraitement LLM (X) | — |
| **ML** | — | ●●● LightGBM, zoo, rolling | — | ●● Random Forest (X) | — |
| **Reinforcement Learning** | — | ●● exécution d'ordres (PPO, OPDS) | ● moteur assez rapide | ●●● SB3, ElegantRL, environnements | — |
| **Backtesting** | ● qualité des décisions, sans simulateur | ●●● coûts, limites, exécuteurs imbriqués, IC | ●●● événementiel déterministe, fill/fee/latence | ●● boucles env ; `bt` (X) | ●● simulateur d'executors |
| **Risk management** | ● débat LLM, aucune limite dure | ●● modèles de covariance | ●●● RiskEngine pré-trade, ACTIVE/REDUCING/HALTED | ●● turbulence ; stops, cooldown, rotation (X) | ●●● Condor : limites + interception + coupure ; triple barrière |
| **Portefeuille** | ● contexte en entrée | ●●● TopkDropout, optimiseurs | ●●● PnL, positions, NETTING/HEDGING | ●● allocation par poids | ●● portfolio multi-venues |
| **Exécution** | — | ●● simulée | ●●● ordres avancés, réconciliation | ●● Alpaca (X) | ●●● executors, ordres en vol |
| **API exchange** | — | — | ●●● ~17 venues | ● Alpaca, ccxt | ●●● 25+ CEX, DEX |
| **Paper trading** | — | — | ●● sandbox | ●● Alpaca paper | ●●● connecteur paper, dry_run |
| **Production** | ● outil de recherche | ●● service en ligne | ●●● production-grade | ●● scripts de déploiement | ●●● bots en production |
| Langage | Python / LangGraph | Python / Cython | Rust / Python | Python | Python / Cython (+ React) |
| Licence | Apache-2.0 | MIT | **LGPL-3.0** | MIT / Apache-2.0 | Apache-2.0 / MIT |
| Tourne sur Cloudflare Workers ? | Non | Non | Non | Non | Non |

### Lecture de la matrice

1. **Aucun dépôt ne couvre tout.** Le meilleur en IA (TradingAgents) n'a ni
   exécution ni risque quantitatif. Les meilleurs en exécution et en risque
   (Nautilus, Hummingbot) n'ont pas d'IA de décision.
2. **Aucun ne tourne sur notre plateforme cible.** Tous exigent un processus
   Python ou Rust permanent. Intégrer l'un d'eux « tel quel » imposerait un
   serveur à exploiter, ce qui contredit l'objectif GitHub → Cloudflare → iPhone.
3. **Les idées sont complémentaires.** Chaque dépôt excelle sur une couche
   différente de la chaîne que nous voulons construire.

---

## 2. Ce que chaque dépôt apporte à notre architecture

| Couche de notre application | Dépôt de référence | Idées retenues |
| --- | --- | --- |
| Data engine | TradingAgents, Nautilus | Routage de fournisseurs avec repli ; seules les bougies **fermées** sont visibles ; horodatage à la clôture ; `as_of` imposé ; absence ≠ vide |
| Feature engineering | Qlib | Bibliothèque de features calculées par le code (type Alpha158) ; fit sur l'entraînement seulement |
| Agents d'analyse | TradingAgents | Rôles spécialisés ; sorties structurées ; snapshot vérifié ; identité déterministe |
| Trader Agent | TradingAgents, Condor | Proposition structurée (action, entrée, stop, objectif, horizon, confiance) ; **aucun outil d'exécution** |
| Portfolio Manager | FinRL-X, Nautilus | Contrat par **exposition cible** ; dimensionnement à risque fixe (`sizing.rs`) |
| Risk Engine | Nautilus, Condor, FinRL-X | Entre décision et exécution, **seul** à produire un ordre approuvé ; ACTIVE/REDUCING/HALTED ; fail-closed ; limites de débit ; stops, refroidissement, rotation |
| Execution engine | Nautilus, Hummingbot | Interface de venue ; simulateur partagé paper/backtest ; identifiant client ; résultat inconnu et réconciliation (live) |
| Backtest | Qlib, Nautilus, FinRL-X | Segments TRAIN/VALIDATION/TEST/OOS avec embargo ; exécution à *t+1* ; modèle de coûts ; walk-forward ; métriques géométriques ; IC des signaux |
| Mémoire | TradingAgents, Condor | Journal complet par décision ; règlement différé ; réflexion **proposée** et jamais injectée à l'aveugle ; filtre point-in-time |
| Gouvernance de l'autonomie | Condor | Modes explicites ; interception de chaque action ; pas d'appel LLM quand le risque bloque ; plafond de coût LLM ; expiration = refus |
| Couche LLM | TradingAgents, Condor | Usine de fournisseurs ; niveaux deep/quick ; table de capacités ; OpenAI-compatible pour GPT, Gemini et les modèles locaux |
| Interface | BoxingCoach (votre projet), Condor | React + Vite + tokens CSS (BoxingCoach) ; lightweight-charts pour les graphiques financiers (utilisé aussi par Condor) |

---

## 3. Ce que nous refusons explicitement

| Pratique observée | Où | Pourquoi nous la refusons |
| --- | --- | --- |
| Risque décidé par un débat LLM | TradingAgents | Un LLM peut se convaincre de tout ; le risque doit être du code déterministe |
| Repli en texte libre pour une décision | TradingAgents | Une décision non structurée n'est pas vérifiable |
| Transmission intégrale de la prose entre agents | TradingAgents | Coût en tokens, propagation d'erreurs |
| Levier 20× par défaut | Hummingbot | Contraire à un démarrage prudent |
| Mode paper déduit de l'URL | FinRL-X | Le mode doit être explicite et journalisé |
| Récompense RL en P&L brut | FinRL | Encourage la prise de risque, sur-apprentissage |
| Liquidation binaire totale | FinRL | Coûteuse ; nous préférons un état REDUCING progressif |
| Dashboards Streamlit / Plotly | FinRL-X | C'est exactement le « dashboard Python » à éviter |
| Annualisation arithmétique par défaut | Qlib | Nous suivons un capital réel : métriques géométriques |
| Serveur Python permanent | tous | Contraire à GitHub → Cloudflare → iPhone |

---

## 4. Réutilisation de code : décision

**Aucune ligne de code n'est copiée** depuis ces dépôts :

- le runtime cible (TypeScript sur Cloudflare Workers) rend le code Python et
  Rust non réutilisable tel quel ;
- NautilusTrader est sous **LGPL-3.0** : copier son code imposerait des
  obligations de redistribution ;
- les prompts de TradingAgents sont écrits pour ses contrats en prose ; les
  nôtres sont écrits pour nos schémas structurés.

Ce que nous reprenons, ce sont des **concepts d'architecture et des méthodes**
(non protégés par le droit d'auteur), cités dans `THIRD_PARTY_NOTICES.md`. Les
formules d'indicateurs et de métriques (RSI de Wilder, ATR, Sharpe…) sont des
définitions publiques standard, réimplémentées et testées.

---

## 5. Conclusion

L'application sera **une plateforme unique**, en TypeScript de bout en bout,
déployée sur Cloudflare. Elle réunit :

- la **structure d'agents** et les **garde-fous temporels** de TradingAgents ;
- la **gouvernance de l'autonomie** de Condor ;
- l'**architecture risque / exécution** de NautilusTrader ;
- la **méthodologie de validation** de Qlib ;
- le **contrat par exposition cible** de FinRL-X ;
- l'**anatomie de connecteurs** de Hummingbot pour le futur live.

L'architecture détaillée est dans [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
