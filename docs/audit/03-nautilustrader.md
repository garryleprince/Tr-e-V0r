# Fiche 3 — NautilusTrader (Nautech Systems)

| | |
| --- | --- |
| Dépôt | https://github.com/nautechsystems/nautilus_trader |
| Commit analysé | `cd417b8` (26 septembre 2026), transition v2 en cours (cœur Rust + bindings PyO3) |
| Licence | **LGPL-3.0** (fichier `LICENSE` vérifié) ; marque déposée (`TRADEMARK.md`) |
| Langage | Rust (cœur), Python (plan de contrôle) |
| Positionnement | Moteur de trading événementiel « production-grade », multi-actifs et multi-venues |

---

## 1. Objectif

Supprimer la séparation entre recherche (souvent vectorisée en Python) et
production (souvent réécrite en langage compilé). Le **même code** de stratégie
s'exécute en backtest et en live, sur un runtime déterministe et événementiel.

Le README exclut explicitement du périmètre les tableaux de bord UI,
l'orchestration distribuée et l'outillage IA/ML intégré.

---

## 2. Architecture (`docs/concepts/architecture.md`)

Styles revendiqués : domain-driven design, architecture événementielle, messagerie
pub/sub et requête/réponse, **ports & adaptateurs**, **crash-only design**.

```
Data clients ──► DataEngine ──► Cache ◄──► (Redis optionnel)
                     │
                     ▼ publish
                 MessageBus ──► Trader (acteurs, stratégies, algorithmes)
                                   │ commandes de trading
                                   ▼
                               RiskEngine ──(commandes validées)──► ExecutionEngine ◄──► Execution clients
                                   ▲                                     │
                  événements ordres/positions ◄── MessageBus ◄───────────┘
                                   ▼
                               Portfolio (soldes, positions nettes, marge, PnL, exposition)
```

Le **RiskEngine est placé entre la stratégie et l'exécution** : aucune commande
n'atteint un client d'exécution sans l'avoir traversé.

### 2.1 RiskEngine (`crates/risk/src/engine/`)

- **`TradingState`** à trois états :
  - `ACTIVE` : tout est permis ;
  - `REDUCING` : seuls les ordres qui **réduisent** une position passent ;
  - `HALTED` : toute nouvelle soumission ou modification est refusée
    (`OrderDeniedReason::TradingHalted`).
- Contrôles pré-trade :
  - précision du prix et de la quantité par instrument ;
  - **notionnel maximal par ordre** et par instrument (`max_notional_per_order`) ;
  - vérification du solde, notamment la vente en compte cash (`check_cash_sell_balance`) ;
  - logique reduce-only ;
  - refus s'il n'y a pas de prix de marché (`deny_no_market_price`) ;
  - **limites de débit** de soumission et de modification (100 par seconde par défaut).
- `bypass` possible, mais explicite dans la config.
- `sizing.rs` : dimensionnement de position à risque fixe.

### 2.2 Ordres et exécution

- Ordres **event-sourced** : chaque ordre commence par `OrderInitialized`, et
  chaque événement est validé contre une **machine à états**. Une transition
  invalide ou un `trade_id` de fill dupliqué est rejeté.
- Types d'ordres avancés : IOC, FOK, GTC, GTD, post-only, reduce-only, iceberg,
  OCO/OUO/OTO, émulation d'ordres conditionnels.
- **Politiques d'exécution** (`execution/policies.md`) : un échec réseau peut
  laisser le résultat d'une commande **inconnu**. Le moteur distingue échec local
  définitif, résultat définitif de la venue et résultat inconnu. Il ne garantit
  pas l'exactly-once et ne rejoue que les commandes idempotentes.
- **Réconciliation** au démarrage et en continu entre l'état local et les
  rapports de la venue, y compris pour les ordres créés hors du système.

### 2.3 Backtest (`docs/concepts/backtesting/`)

- Horloge contrôlée, données historiques en nanosecondes : ticks, bars, carnets
  L1/L2/L3.
- **Exécution sur barres** : chaque barre OHLC est décomposée en quatre mises à
  jour synthétiques (O → H → L → C, ou ordre adaptatif selon la distance de
  l'ouverture aux extrêmes). La doc prévient qu'il s'agit d'une **heuristique**
  qui ne reconstitue pas le vrai chemin. C'est décisif quand un stop et un
  objectif sont tous deux touchés dans la même barre.
- **Convention d'horodatage** : `ts_init` de la barre = **clôture** de
  l'intervalle, pour qu'une barre ne soit jamais visible avant d'être formée.
- Avertissement explicite : il n'existe pas de mode natif « exécution à
  l'ouverture de la barre suivante ». Utiliser l'ouverture de la barre courante
  dans `on_bar` introduirait un look-ahead.
- `FillModel` (probabilité de remplissage des limites, probabilité de slippage),
  `FeeModel` (maker/taker), `LatencyModel`.
- OMS `NETTING` ou `HEDGING` ; comptes cash ou marge ; courbe d'equity automatique.

### 2.4 Adaptateurs

Binance, Bybit, Coinbase, Kraken, OKX, Deribit, dYdX, Hyperliquid, Interactive
Brokers, Databento, Tardis, Betfair, Polymarket… Chaque adaptateur traduit l'API
brute vers un **modèle de domaine normalisé**.

---

## 3. Technologies

Rust (tokio, mimalloc, rust_decimal), Python 3.12–3.14 (PyO3), Redis optionnel,
Arrow/Parquet pour le catalogue de données, Docker.

---

## 4. Composants et fonctionnalités intéressants

1. **RiskEngine entre stratégie et exécution**, sans contournement possible
   (hors `bypass` explicite).
2. **TradingState ACTIVE / REDUCING / HALTED** : c'est exactement le modèle d'un
   kill switch gradué.
3. **Ordres event-sourced**, avec machine à états et déduplication des fills.
4. **Parité backtest / live** : même code, même sémantique.
5. **Exécution sur barres** documentée, avec ses ambiguïtés.
6. Convention **horodatage = clôture**.
7. Résultat de commande **inconnu** traité comme un état à part entière.
8. **Réconciliation** avec la venue.
9. **Crash-only design** : le démarrage *est* la procédure de récupération.

---

## 5. Limites pour notre projet

| Limite | Conséquence |
| --- | --- |
| Rust + Python, processus longue durée | **Impossible à exécuter dans Cloudflare Workers** |
| Complexité très élevée (nanosecondes, carnets L3, multi-venues) | Surdimensionné pour du swing trading sur bougies |
| LGPL-3.0 | Utilisable comme bibliothèque dans un service séparé, mais pas intégrable par copie de code dans une application propriétaire sans obligations |
| Pas d'UI ni d'IA (choix assumé) | À construire de toute façon |
| v2 en transition (API qui bouge) | Risque d'instabilité si on l'intègre maintenant |

---

## 6. Licence et réutilisation

**LGPL-3.0** : utiliser la bibliothèque telle quelle, dans un processus séparé, ne
contamine pas notre code. Copier ou modifier son code imposerait de redistribuer
ces parties sous LGPL. **Nous ne copions aucun code.** Nous reprenons des
**concepts d'architecture**, qui ne sont pas protégés par le droit d'auteur.
Nous n'utilisons ni le nom ni la marque.

## 7. Faut-il l'utiliser directement ?

**Non pour V0.1 à V1.** Raisons :

1. Il ne s'exécute pas sur notre plateforme (Workers). Il faudrait un serveur
   permanent, donc une exploitation, un coût et une surface d'attaque en plus.
2. Pour des décisions quotidiennes ou horaires sur quelques actifs, un moteur
   TypeScript simple, fidèle aux mêmes principes, est suffisant et testable.
3. Son API v2 est en transition.

**Réévaluation prévue** si l'on passe au trading intrajournalier multi-venues
(carnets, latence, ordres complexes). Dans ce cas, Nautilus serait déployé comme
un **service d'exécution séparé** derrière notre interface `ExecutionVenue`.
L'architecture est prévue pour ce remplacement.

## 8. Ce que nous reprenons (adapté)

| Concept | Adaptation |
| --- | --- |
| RiskEngine entre décision et exécution | Le `RiskEngine` est le **seul** constructeur d'un `ApprovedOrder` ; l'`ExecutionEngine` n'accepte que ce type |
| TradingState | Kill switch à trois états `ACTIVE` / `REDUCING` / `HALTED`, tenu dans un Durable Object |
| Ordres event-sourced | Journal d'événements d'ordre (`order_events`) et transitions validées (V0.4 complet ; V0.1 : statuts contrôlés) |
| Parité backtest / paper / live | Le **même** `SimulatedExchange` (fills, frais, slippage) sert au paper trading et au backtest ; seule la venue change en live |
| Exécution sur barres | Stop et objectif touchés dans la même barre : **le stop est réputé touché d'abord** (hypothèse pessimiste, documentée) |
| Horodatage = clôture | Une bougie n'est utilisable qu'une fois **fermée** ; la bougie en cours est exclue de toute analyse |
| Next-bar-open | Implémenté **explicitement** dans notre backtest : signal à la clôture de *t*, exécution à l'ouverture de *t+1* |
| Résultat inconnu et réconciliation | Pour le live (V1) : statut `UNKNOWN` et réconciliation au démarrage et périodique |
| Limite de débit d'ordres | Limite de nouveaux ordres par jour et par heure (anti-emballement de boucle) |
| Refus sans prix de marché | Données trop anciennes ⇒ refus (fail-closed) |

## 9. Pertinence

**Très élevée pour l'architecture** du risque, de l'exécution et de la simulation.
**Faible comme dépendance directe** à ce stade.
