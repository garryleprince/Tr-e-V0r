# Tr-e-V0r — trading assisté par IA

Bureau de trading piloté par des agents IA, conçu comme un produit :
**GitHub → Cloudflare → iPhone** (PWA installable).

Des agents analysent, un trader propose, un gestionnaire de portefeuille dimensionne,
et un **Risk Engine indépendant décide**. Aucun modèle de langage ne peut contourner le
Risk Engine : lui seul peut fabriquer un ordre approuvé (règle vérifiée par un test
d'architecture).

> **Version 0.1 — simulation uniquement.** Aucun ordre réel n'est possible : il n'existe
> aucun adaptateur de courtier dans le code. L'état exact de chaque exigence
> (implémenté, partiel, prévu) est dans [`docs/AUDIT.md`](docs/AUDIT.md), et les limites
> connues dans [`docs/LIMITES.md`](docs/LIMITES.md).

## Ce que fait la V0.1

| Domaine | Contenu |
| --- | --- |
| Interface | PWA iPhone en français, thème sombre et clair, onglets Accueil / Marché / IA / Portefeuille / Plus, hors ligne pour la coque (jamais pour les prix) |
| Authentification | Compte propriétaire unique, cookie HttpOnly `__Host-`, ré-authentification pour les actions sensibles, verrouillage après échecs |
| Données de marché | Coinbase (crypto, Kraken en secours), Alpha Vantage (actions et ETF, quotidien) ; bougies **clôturées** uniquement |
| Graphiques | Chandeliers, volume dans un panneau séparé, MM50 et MM200, lignes Entrée / Stop / Objectif, réticule, vue tableau ; capital et drawdown |
| IA | Analyste technique et trader (Claude par défaut, ou tout fournisseur compatible OpenAI) ; sans clé, analyste à règles signalé « sans IA » |
| Risque | Risk Engine avec 20 limites, plafonds en dur, coupe-circuit ACTIF / RÉDUCTION / ARRÊT, arrêt forcé par variable de déploiement |
| Simulation | Compte fictif, frais et glissement, surveillance des stops toutes les 15 minutes |
| Journal | Chaque analyse : données au moment de la décision, rapports d'agents, échange exact avec le modèle, décision, verdict règle par règle, ordre, coût |
| Backtest | Moteur, segments TRAIN / VALIDATION / TEST / OOS et métriques dans le code et testés ; écran prévu en V0.3 |

## Démarrer en local

Prérequis : Node 22.

```bash
npm install
cp .dev.vars.example .dev.vars    # puis remplir SETUP_TOKEN et SESSION_PEPPER
npm run build                     # typecheck + build de la PWA dans dist/
npm run db:migrate:local          # base D1 locale
npx wrangler dev --port 8787      # Worker + API + PWA sur http://127.0.0.1:8787
```

Ouvrez http://127.0.0.1:8787, créez le compte propriétaire avec la valeur de
`SETUP_TOKEN`, puis ouvrez un actif et lancez une analyse.

Sans accès réseau aux API de marché, mettez `MARKET_DATA_MODE=fixture` dans `.dev.vars` :
l'application utilise un historique réel enregistré (BTC, ETH, SPY), avec un bandeau
permanent « Données de démonstration ». Ce mode est refusé en production.

Pour développer l'interface avec rechargement à chaud : `npm run dev:api` dans un
terminal, `npm run dev` dans un autre (Vite redirige `/api` vers le Worker).

## Vérifier

```bash
npm run typecheck        # web, Worker et tests, TypeScript strict
npm test                 # 127 tests : quant, agents, risque, simulation, backtest, auth, API, architecture
npm run verify:browser   # parcours complet sur iPhone émulé (Worker local lancé, base vide)
```

Le parcours navigateur crée le compte, lance une analyse, actionne le coupe-circuit,
vérifie le verrouillage du mode réel, change de thème, se déconnecte et se reconnecte.
Il échoue sur toute erreur console, toute réponse 5xx et tout écran plus large que le
téléphone. Les captures vont dans `test-results/e2e/`.

## Déployer

Voir [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md) : création de la base D1, secrets,
migrations, branchement de Cloudflare Workers Builds sur ce dépôt, installation sur
l'iPhone.

## Structure

```
src/core/     domaine, indicateurs, agents, Risk Engine, portefeuille, simulation, backtest (pur, sans I/O)
src/server/   Worker Cloudflare : API Hono, D1, Durable Object TradingDesk, fournisseurs, LLM, tâches planifiées
src/web/      PWA React : écrans, graphiques, design system
migrations/   schéma D1
tests/        tests unitaires et d'intégration (Vitest), parcours e2e (Playwright)
docs/         audit des dépôts, architecture, choix techniques, risque, backtest, feuille de route
```

## Documentation

| Document | Contenu |
| --- | --- |
| [`docs/AUDIT.md`](docs/AUDIT.md) | État de chaque exigence à la livraison de la V0.1 |
| [`docs/LIMITES.md`](docs/LIMITES.md) | Limites connues, ce qui n'a pas pu être vérifié |
| [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md) | Mise en production sur Cloudflare, installation iPhone |
| [`docs/audit/`](docs/audit/) | Audit de TradingAgents, Qlib, NautilusTrader, FinRL/FinRL-X, Hummingbot/Condor |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture, flux, modèle de données, API |
| [`docs/CHOIX_TECHNIQUES.md`](docs/CHOIX_TECHNIQUES.md) | Technologies retenues et alternatives écartées |
| [`docs/AGENTS_IA.md`](docs/AGENTS_IA.md) | Agents, abstraction LLM, niveaux d'autonomie |
| [`docs/RISQUE_ET_SECURITE.md`](docs/RISQUE_ET_SECURITE.md) | Risk Engine, coupe-circuit, modes, sécurité |
| [`docs/BACKTESTING.md`](docs/BACKTESTING.md) | Méthodologie et biais évités |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | V0.1 → V1 |

## Avertissement

Logiciel expérimental. Aucune décision produite par ce système ne constitue un
conseil en investissement. Les performances simulées ne préjugent pas des résultats
réels. Le trading comporte un risque de perte en capital.
