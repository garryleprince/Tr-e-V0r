# Risque et sécurité

## Partie A — Risk Engine

### A.1 Position dans l'architecture

```
Trader (IA) ──► Portfolio Manager ──► ┌──────────────────────────────┐ ──► Execution Engine
                                      │  TradingDesk (Durable Object)│
                                      │   ├─ verrou séquentiel       │
                                      │   ├─ état kill switch        │
                                      │   └─ Risk Engine (pur)       │
                                      └──────────────────────────────┘
```

- **Indépendant de l'IA** : module pur (`src/core/risk`), sans aucun appel LLM.
- **Seul constructeur d'`ApprovedOrder`**. L'Execution Engine n'accepte que ce type.
- **Fail-closed** : une donnée manquante ou périmée refuse toute ouverture. Les
  réductions de risque (freins) passent toujours (principe de Condor).
- **Verdict détaillé** : chaque règle produit `{ règle, passé, valeur, limite, message }`.
  Le verdict est enregistré avec une copie des limites en vigueur.

### A.2 Les règles

« Ouverture » = tout ordre qui augmente l'exposition. « Réduction » = tout ordre
qui la diminue.

| # | Règle | Défaut | S'applique à | Effet si violée |
| --- | --- | --- | --- | --- |
| 1 | Kill switch `HALTED` | — | tout ordre issu de l'IA | refus |
| 2 | Kill switch `REDUCING` | — | ouvertures | refus |
| 3 | Mode `RESEARCH` | — | tout | pas d'exécution (la décision est évaluée pour information) |
| 4 | Stop-loss obligatoire, du bon côté du prix | toujours | ouvertures | refus |
| 5 | Distance du stop : ≥ 0,5 × ATR et ≤ 15 % | 0,5 ATR / 15 % | ouvertures | refus |
| 6 | Risque par trade (perte au stop) | ≤ 1 % de l'equity | ouvertures | **réduction de la quantité**, refus si sous le minimum |
| 7 | Taille de position (notionnel) | ≤ 20 % de l'equity | ouvertures | réduction de la quantité |
| 8 | Exposition brute totale | ≤ 60 % de l'equity | ouvertures | réduction, sinon refus |
| 9 | Nombre de positions simultanées | ≤ 3 | ouvertures | refus |
| 10 | Corrélation avec les positions ouvertes (rendements sur 60 bougies) | ≤ 0,8 | ouvertures | refus |
| 11 | Liquidité : volume moyen en dollars sur 20 bougies ; participation de l'ordre | ≥ 5 M$ ; ≤ 1 % | ouvertures | refus |
| 12 | Spread (si une cotation bid/ask est disponible) | ≤ 30 pb | ouvertures | refus ; spread inconnu : avertissement en PAPER, refus en LIVE |
| 13 | Volatilité : ATR en % du prix | ≤ 10 % | ouvertures | refus |
| 14 | Confiance minimale | ≥ 0,55 | ouvertures | refus |
| 15 | Rapport gain/risque (si un objectif est fourni) | ≥ 1,2 | ouvertures | refus |
| 16 | Bande de prix : écart entre entrée et prix de référence | ≤ 2 % | tout | refus (niveau halluciné ou périmé) |
| 17 | Fraîcheur des données (dernière bougie fermée) | ≤ 2 unités de temps (4 jours pour les actions en journalier) | tout | refus des ouvertures ; réductions autorisées |
| 18 | Pertes consécutives | 3, puis refroidissement de 24 h | ouvertures | refus pendant le refroidissement |
| 19 | Limite journalière de perte (réalisée + latente) | 3 % | ouvertures | refus, et **passage automatique en `REDUCING`** |
| 20 | Drawdown maximal depuis le pic d'equity | 15 % | tout ordre IA | refus, et **passage automatique en `HALTED`** |
| 21 | Nombre de nouveaux ordres par jour | 5 | ouvertures | refus (anti-emballement de boucle) |
| 22 | Cash disponible | quantité × prix + frais ≤ cash | ouvertures | réduction, sinon refus |
| 23 | Vente à découvert | interdite en V0.1 | ventes | refus si la vente dépasse la position |

### A.3 Plafonds non modifiables

Les limites se règlent dans l'application, mais **à l'intérieur de plafonds
codés en dur**, qu'aucun réglage ne peut dépasser :

| Limite | Plafond absolu |
| --- | --- |
| Risque par trade | 5 % |
| Taille de position | 100 % de l'equity |
| Exposition brute | 100 % (**pas de levier**) |
| Positions simultanées | 20 |
| Drawdown maximal avant coupure | 50 % |
| Perte journalière | 20 % |
| Stop-loss obligatoire | non désactivable |

**Resserrer** une limite est immédiat. **Desserrer** exige une ré-authentification.
Chaque modification est journalisée avec l'ancienne et la nouvelle valeur.

### A.4 Kill switch

Trois états, repris de `TradingState` de NautilusTrader :

| État | Ordres de l'IA | Stops et objectifs des positions existantes | Clôture manuelle |
| --- | --- | --- | --- |
| `ACTIVE` | ouvertures et réductions | ✅ | ✅ |
| `REDUCING` | réductions uniquement | ✅ | ✅ |
| `HALTED` | **aucun** | ✅ (équivalent des ordres stop déjà posés chez le broker) | ✅ |

Déclencheurs :

- **manuel** : un bouton toujours accessible (accueil et réglages). Arrêter est
  immédiat ; **reprendre exige une ré-authentification** ;
- **automatique** : perte journalière (`REDUCING`), drawdown maximal (`HALTED`) ;
- **déploiement** : la variable `KILL_SWITCH=halt` force `HALTED`, quel que soit
  l'état stocké. C'est l'arrêt d'urgence ultime, modifiable depuis le tableau de
  bord Cloudflare même si l'application est inaccessible.

L'état est tenu par le Durable Object (cohérence forte, effet immédiat) et
recopié dans le journal d'audit.

### A.5 Modes et impossibilité d'un passage accidentel au réel

| Garantie | Mécanisme |
| --- | --- |
| LIVE désactivé par défaut | Mode initial `PAPER` (ou `RESEARCH`, au choix lors de l'installation) |
| Pas de venue réelle en V0.1 | Le code n'en contient aucune ; `POST /api/desk/mode {LIVE}` renvoie 403 |
| Comptes séparés | Le paper et le live ont des comptes, des positions et des ordres distincts (colonne `mode`) |
| Routage par le desk | La venue est choisie par le Durable Object selon le mode stocké, jamais selon la requête |
| Conditions cumulatives en V1 | Variable de déploiement + adaptateur configuré + critères paper atteints + ré-authentification + phrase de confirmation |
| Retour en arrière toujours possible | LIVE → PAPER ou RESEARCH sans condition, immédiatement |

---

## Partie B — Sécurité applicative

### B.1 Secrets

| Secret | Où | Jamais |
| --- | --- | --- |
| `SETUP_TOKEN` | secret Worker | dans Git ; inutile après la création du compte |
| `ANTHROPIC_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` | secrets Worker | côté client, dans les réglages en base, dans les logs |
| `ALPHAVANTAGE_API_KEY` | secret Worker | idem |
| `SESSION_PEPPER` | secret Worker | sert à hacher les IP pour la limitation des tentatives |
| Clés broker (V1) | secrets Worker | idem ; jamais renvoyées par l'API |

En local : `.dev.vars` (ignoré par Git) ; `.dev.vars.example` documente les noms.

### B.2 Authentification

- **Installation** : `POST /api/auth/setup` n'est possible que si aucun compte
  n'existe **et** si le jeton d'installation fourni correspond au secret
  `SETUP_TOKEN` (comparaison à temps constant). Sans ce secret, l'installation
  est désactivée. Découvrir l'URL ne permet donc pas de s'approprier l'instance.
- **Mot de passe** : 12 caractères minimum, dérivé par PBKDF2-SHA-256
  (100 000 itérations, le maximum de WebCrypto sur Workers), sel de 16 octets.
  Le plafond d'itérations est compensé par la limitation des tentatives
  ci-dessous et la longueur minimale. Passkeys prévues en V0.2.
- **Sessions** : jeton aléatoire de 256 bits dans un cookie `__Host-` `HttpOnly`,
  `Secure`, `SameSite=Strict`. **Seule son empreinte SHA-256 est stockée.**
  Expiration à 30 jours, inactivité maximale 14 jours, révocation à la déconnexion.
- **Limitation** : 10 tentatives par IP (hachée) toutes les 15 minutes ; 5 échecs
  consécutifs verrouillent le compte 15 minutes.
- **Ré-authentification** (fenêtre de 10 minutes) pour : reprendre après un
  kill switch, desserrer une limite, changer de mode, réinitialiser le compte paper.

### B.3 Protection des requêtes

- CSRF : `SameSite=Strict` **et** en-tête `X-Trevor-Client` obligatoire sur
  toute requête modifiante **et** contrôle de l'en-tête `Origin`.
- Validation zod de chaque entrée ; champs inconnus refusés.
- En-têtes de sécurité (CSP stricte `default-src 'self'`, `frame-ancestors 'none'`,
  `nosniff`, `no-referrer`, `Permissions-Policy` restrictive) sur l'API et les actifs.
- Aucun script tiers ; les graphiques sont empaquetés dans le bundle.

### B.4 Clés de trading (V1) : principe du moindre privilège

- Permissions **lecture + trading uniquement** ; **retraits désactivés** côté broker.
- Sous-compte dédié, approvisionné avec le seul capital alloué.
- Limites de risque du broker activées quand elles existent (en plus des nôtres).
- Liste blanche d'IP : les IP de sortie de Workers ne sont pas fixes. Si le
  broker l'exige, un relais à IP fixe devra être ajouté (point ouvert V1).
- Rotation des clés documentée ; journalisation de chaque ordre envoyé.

### B.5 Journal d'audit

Événements tracés dans `events` : connexions (réussies et échouées),
ré-authentifications, changements de mode, actions sur le kill switch
(manuelles et automatiques), modifications de limites (avant/après), refus du
risque, erreurs d'agents, erreurs de fournisseurs, réinitialisations du compte paper.

### B.6 Défense en profondeur optionnelle

**Cloudflare Access** devant le domaine : une connexion Cloudflare (e-mail OTP,
GitHub…) avant même d'atteindre l'application. Aucune modification du code
n'est nécessaire. Recommandé avant le passage en LIVE.
