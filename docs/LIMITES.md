# Limites connues de la V0.1

Ce document dit ce qui n'a **pas** pu être vérifié, et ce que l'application ne fait pas
encore ou fait avec des compromis. Il est mis à jour à chaque version.

## Ce qui n'a pas pu être vérifié dans l'environnement de développement

| Point | Pourquoi | Ce qui a été fait à la place | À vérifier |
| --- | --- | --- | --- |
| Appels en direct à Coinbase, Kraken, Yahoo Finance, BCE, Alpha Vantage | Le réseau du bac à sable de développement bloque ces hôtes | Analyseurs testés sur les formats documentés ; parcours complet sur un historique **réel enregistré** (mode démonstration) | Au premier déploiement : ouvrir BTC (source « Coinbase »), LVMH (source « Yahoo Finance »), et vérifier dans le portefeuille le taux EUR/USD appliqué |
| Appels réels à Claude ou à un fournisseur compatible OpenAI | Aucune clé d'API dans l'environnement de développement | Adaptateurs testés contre des réponses enregistrées : sortie structurée, refus, JSON invalide, clé refusée, budget | Poser `ANTHROPIC_API_KEY`, lancer une analyse, lire l'échange exact dans le détail de l'analyse |
| Safari sur un vrai iPhone | Le parcours automatique tourne dans Chromium en émulation iPhone (taille, écran tactile, agent utilisateur) | Captures relues écran par écran, contrôle automatique d'absence de débordement horizontal | Installer la PWA sur l'iPhone et parcourir les onglets |
| Workers Builds (déploiement depuis GitHub) | Nécessite votre compte Cloudflare | Configuration et procédure documentées | Voir `DEPLOIEMENT.md` |

## Données de marché

- **Actions et ETF : Yahoo Finance, source NON OFFICIELLE** (votre choix du 27/09/2026, pour
  n'avoir aucune clé). Yahoo a fermé son API publique en 2017 ; l'accès utilisé est interne,
  non documenté, et ses conditions d'utilisation n'autorisent pas l'accès automatisé. Il peut
  être bloqué ou modifié du jour au lendemain : l'application le signale alors (« données
  indisponibles ») et ne fabrique jamais de cours. Si vous ajoutez un jour une clé Alpha
  Vantage, elle prend le relais automatiquement.
- Yahoo fournit environ deux ans d'historique : la MM200 est disponible sur les actions.
  Pas de bid/ask : le contrôle de spread est signalé « non vérifié » en simulation (il
  bloquerait en mode réel).
- **Surveillance des stops des actions** : quotidienne, sur la bougie journalière (pas de
  données intraday gratuites). Un stop franchi en séance est constaté à la clôture ; un
  écart d'ouverture est exécuté au prix d'ouverture, jamais au prix du stop.
- **Kraken** (secours crypto) couvre les 9 cryptos de l'univers.
- **Mode démonstration** : historique réel enregistré le 26/09/2026 pour BTC, ETH et SPY,
  décalé pour que la dernière bougie soit celle d'hier. SOL n'y figure pas et s'affiche sans
  données. Ce mode est refusé si `ENVIRONMENT=production`.

## Multi-marchés et devises

- **Aucune clé nécessaire** : crypto via Coinbase, actions via Yahoo Finance, taux EUR/USD via
  la Banque centrale européenne (taux de référence officiels, publiés vers 16 h les jours
  ouvrés TARGET2). En secours pour le taux : Kraken, Yahoo, puis Alpha Vantage si une clé
  existe.
- **Sans aucun taux EUR/USD récent** (toutes les sources en panne plus de 5 jours), un
  compte en euros **refuse d'ouvrir** une position en dollars, crypto comprise. C'est
  volontaire. Les stops continuent de fonctionner au dernier taux connu.
- **Alpha Vantage (facultatif)** : s'il est configuré, son quota (25 appels par jour en
  gratuit) est compté et protégé. Une clé payante se déclare via `ALPHAVANTAGE_DAILY_LIMIT`.
- **Taux de change quotidien** : les positions sont valorisées au dernier cours de clôture
  EUR/USD, pas en continu. Écart typique : quelques dixièmes de pour cent sur une journée.
- **Symboles européens** : `MC.PAR`, `SAP.DEX` et `ASML.AMS` ont été vérifiés en direct.
  Les autres (TotalEnergies, Airbus, Sanofi, L'Oréal, Schneider, BNP Paribas, Siemens,
  Allianz) suivent la même convention, sans vérification individuelle.
- **Actions à l'unité** (pas de fraction) : sur un petit capital, une action chère peut
  tomber sous la taille minimale et être refusée.
- **Jours fériés** non modélisés : quelques requêtes inutiles par an, rien de plus.
- **Liste de suivi limitée à 12 actifs** : le cycle quotidien doit tenir dans une exécution
  planifiée. L'étendre passera par une file de tâches (Cloudflare Queues).

## IA

- Seuls l'**analyste technique** et le **trader** existent. Les analystes fondamental,
  sentiment et macro apparaissent comme « indisponibles » (V0.2). Avec un seul agent
  disponible, le consensus est trivialement unanime : il n'apporte pas encore
  d'information.
- **Repli côté serveur de Claude** : les requêtes activent l'option `fallbacks: "default"`
  (en-tête bêta `server-side-fallback-2026-07-01`). Si le modèle demandé refuse une
  requête pour raison de politique d'usage, l'API peut la rejouer sur un autre modèle
  recommandé par Anthropic. Le modèle **effectivement** utilisé est enregistré dans le
  rapport de l'agent. Pour le désactiver : retirer `fallbacks` et l'en-tête dans
  `src/server/llm/anthropic.ts`.
- **Budget IA illimité par défaut**, conformément à votre choix. Aucun plafond n'est
  appliqué par l'application. Fixez une limite de dépense dans la console Anthropic : c'est
  le seul garde-fou contre une facture inattendue.
- Les coûts sont calculés avec une table de prix intégrée au code
  (`src/server/llm/pricing.ts`). Un modèle absent de la table est facturé au tarif le plus
  élevé connu et marqué « estimé ».
- Aucun apprentissage automatique : les erreurs sont journalisées, pas encore analysées
  (V0.3).

## Simulation et métriques

- Relevés du capital toutes les 15 minutes. Les ratios annualisés (Sharpe, Sortino,
  volatilité) ne s'affichent qu'à partir de 30 relevés, le CAGR qu'à partir de 30 jours :
  en dessous, ils seraient du bruit présenté comme une mesure.
- Ordres au marché uniquement, positions longues uniquement (pas de vente à découvert, pas
  de levier).
- Les décisions non exécutées (attente, refus) ne sont pas encore « réglées » a posteriori
  (que se serait-il passé ?) : prévu en V0.3.

## Sécurité

- **PBKDF2 à 100 000 itérations** : c'est le maximum accepté par le runtime des Workers,
  en dessous des 600 000 recommandés par l'OWASP pour SHA-256. Compensé par le verrouillage
  après 5 échecs, la limitation par IP et un mot de passe de 12 caractères minimum. Les
  passkeys (Face ID) sont prévues en V0.2.
- **Pas de réinitialisation de mot de passe** : un seul compte, sans e-mail sortant.
  Procédure de secours dans `DEPLOIEMENT.md` (suppression du compte via `wrangler d1
  execute`, puis nouvelle installation avec le jeton).
- Pas de notifications push (V0.4) : les alertes se lisent dans l'onglet Activité.

## Interface

- L'unité de temps 15 minutes n'est pas proposée dans le graphique (300 bougies = 3 jours,
  peu utile en swing trading). 1 h et 4 h sont disponibles pour la crypto.
- Le logo TradingView reste affiché dans les graphiques : c'est une condition de la
  licence de lightweight-charts.
