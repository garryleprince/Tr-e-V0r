# Déploiement : GitHub → Cloudflare → iPhone

Tout tient dans **un seul Worker Cloudflare** : la PWA (fichiers statiques), l'API
`/api/*`, les tâches planifiées et le Durable Object `TradingDesk`, plus une base **D1**.
Le plan gratuit suffit pour démarrer ; le plan Workers Paid (5 $/mois) est recommandé à
partir de la V0.3 (backtests plus longs).

## 1. Préparer (une fois, depuis votre ordinateur)

```bash
npm install
npx wrangler login
npx wrangler d1 create tr-e-v0r
```

Copiez le `database_id` renvoyé dans `wrangler.jsonc` (à la place de
`00000000-0000-0000-0000-000000000000`), puis committez ce changement : l'identifiant
n'est pas un secret.

Appliquez le schéma à la base de production :

```bash
npm run db:migrate:remote
```

## 2. Premier déploiement et secrets

```bash
npm run deploy     # build + migrations + wrangler deploy
```

Posez ensuite les secrets. Chaque commande demande la valeur de façon masquée ; elle est
chiffrée par Cloudflare et n'apparaît ni dans le dépôt ni dans le navigateur.

| Secret | Obligatoire | Rôle |
| --- | --- | --- |
| `SESSION_PEPPER` | oui | Hachage des IP pour la limitation des tentatives. Sans lui, l'API répond « configuration invalide » |
| `SETUP_TOKEN` | pour l'installation | Prouve que vous êtes l'administrateur à la création du compte. Peut être supprimé ensuite |
| `ANTHROPIC_API_KEY` | non | Active Claude. Sans clé, l'analyste à règles est utilisé et signalé |
| `OPENAI_COMPATIBLE_API_KEY` | non | Pour GPT, Gemini ou un serveur compatible, avec l'URL de base réglée dans l'app |
| `ALPHAVANTAGE_API_KEY` | non | Source de secours pour les actions et le change. Les sources principales ne demandent aucune clé : Coinbase, Yahoo Finance (non officielle) et BCE |

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_PEPPER
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
```

Pour la clé Anthropic : créez une clé dédiée à cette application dans la console
Anthropic, **avec une limite de dépense mensuelle**. Le budget IA de l'application est
illimité par défaut (votre choix) ; cette limite est donc le seul plafond de dépense.
Un plafond quotidien peut être réactivé dans Réglages → Modèle d'IA.

Si vous ajoutez un jour une clé Alpha Vantage payante, relevez le quota compté par l'application :
**Settings → Variables** du Worker, `ALPHAVANTAGE_DAILY_LIMIT` = votre quota (25 par défaut).

## 3. Déploiement automatique depuis GitHub (Workers Builds)

Dans le tableau de bord Cloudflare : **Workers & Pages → tr-e-v0r → Settings → Build →
Connect** au dépôt GitHub `Tr-e-V0r`.

| Réglage | Valeur |
| --- | --- |
| Branche de production | `main` (après fusion de la branche de travail) |
| Commande de build | `npm run build` |
| Commande de déploiement | `npx wrangler deploy` |
| Version de Node | 22 (fichier `.node-version`) |

Chaque push sur `main` redéploie ; les autres branches peuvent produire des versions de
prévisualisation. Quand une nouvelle migration apparaît dans `migrations/`, appliquez-la
avec `npm run db:migrate:remote` **avant** que le code qui en dépend soit déployé. Vous
pouvez aussi ajouter `npx wrangler d1 migrations apply DB --remote &&` en tête de la
commande de déploiement, si le jeton de build dispose du droit d'édition D1. Ce point n'a
pas pu être vérifié depuis l'environnement de développement.

## 4. Première connexion et iPhone

1. Ouvrez l'URL du Worker (`https://tr-e-v0r.<votre-sous-domaine>.workers.dev`).
2. Créez le compte propriétaire avec la valeur de `SETUP_TOKEN`.
3. Supprimez ensuite le jeton : `npx wrangler secret delete SETUP_TOKEN`. L'installation
   devient impossible, même si quelqu'un trouve l'URL.
4. Sur l'iPhone, ouvrez l'URL dans **Safari** → bouton Partager → **Sur l'écran
   d'accueil**. L'application s'ouvre en plein écran, avec son icône.

Un domaine personnalisé se configure dans **Settings → Domains & Routes**. Pour la V1
(argent réel), placer l'application derrière **Cloudflare Access** est recommandé.

## 5. Exploitation

| Besoin | Action |
| --- | --- |
| Arrêt d'urgence depuis l'iPhone | Accueil → Coupe-circuit → Arrêt d'urgence |
| Arrêt d'urgence sans l'application | Tableau de bord Cloudflare → Settings → Variables : `KILL_SWITCH` = `halt`. Prioritaire sur l'état de l'app ; seules les protections (stops) et les clôtures manuelles passent |
| Journaux du Worker | `npx wrangler tail`, ou Observability dans le tableau de bord |
| Tâches planifiées | Surveillance toutes les 15 min ; analyse quotidienne à 00:07 UTC. Dernière exécution visible dans Plus → Sécurité → État du système |
| Tester les tâches en local | `npx wrangler dev --test-scheduled`, puis `curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=7+0+*+*+*"` |

## 6. Mot de passe perdu

Il n'y a qu'un compte et pas d'e-mail sortant. Procédure de secours, depuis votre
ordinateur :

```bash
npx wrangler d1 execute tr-e-v0r --remote --command "DELETE FROM sessions; DELETE FROM users;"
npx wrangler secret put SETUP_TOKEN
```

Puis recréez le compte depuis l'application. Le journal, les décisions et le portefeuille
simulé sont conservés.

## 7. Le mode réel

Il n'existe pas en V0.1 : aucun adaptateur de courtier n'est présent dans le code, et le
serveur refuse le passage en mode Réel. `LIVE_TRADING_ENABLED` doit rester à `false`. Les
conditions prévues pour la V1 sont décrites dans `RISQUE_ET_SECURITE.md`.
