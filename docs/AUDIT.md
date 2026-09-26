# État de la V0.1, exigence par exigence

Légende :
- ✅ implémenté et vérifié (tests automatisés et/ou parcours navigateur) ;
- 🟡 partiel : ce qui existe et ce qui manque sont précisés ;
- ⏳ prévu (version indiquée) ;
- ❌ exclu volontairement.

« Vérifié » veut dire vérifié dans l'environnement de développement : 127 tests Vitest,
plus un parcours complet sur iPhone émulé contre le vrai Worker (`wrangler dev`, D1
locale) en données de démonstration. Ce qui n'a **pas** pu être vérifié est listé dans
[`LIMITES.md`](LIMITES.md).

## 1. Séparation des rôles

| Exigence | État | Où / comment |
| --- | --- | --- |
| IA, moteur quantitatif, Risk Engine, exécution séparés | ✅ | `src/core/agents`, `src/core/quant`, `src/core/risk`, `src/server/execution` |
| Le LLM ne peut pas contourner le Risk Engine | ✅ | `ApprovedOrder` est un type marqué, fabriqué uniquement dans `core/risk/engine.ts` ; la venue n'accepte que ce type ; un test d'architecture interdit toute conversion ailleurs |
| Le LLM ne calcule ni quantité ni prix d'exécution | ✅ | Le trader propose un % indicatif ; la quantité vient du gestionnaire de portefeuille (fraction fixe du risque), puis du Risk Engine |
| Une sortie invalide n'est jamais transformée en « attente » | ✅ | Statut `INVALID` distinct, visible dans le journal (tests `agents`) |
| Un agent absent n'est jamais compté comme neutre | ✅ | Consensus sur les seuls agents disponibles ; les absents sont listés |

## 2. Agents IA

| Exigence | État | Détail |
| --- | --- | --- |
| Analyste technique | ✅ | LLM (sortie structurée validée par schéma) ou règles déterministes sans clé |
| Analyste fondamental | ⏳ V0.2 | Présent dans le pipeline comme « indisponible » |
| Analyste sentiment | ⏳ V0.2 | Idem |
| Analyste macro | ⏳ V0.2 | Idem |
| Trader : action, actif, sens, entrée, stop, objectif, taille, horizon, confiance, justification | ✅ | Plus scénario principal et alternatif, facteurs, condition d'invalidation |
| Gestionnaire de portefeuille | ✅ | Dimensionnement, refus explicites (déjà en position, rien à vendre…) |
| Contrôles de cohérence avant le risque | ✅ | Stop sous l'entrée, objectif au-dessus, entrée à moins de 2 % du marché, niveaux clés à moins de 50 % du prix |
| Abstraction LLM : Claude / GPT / Gemini / local | 🟡 | Claude (SDK Anthropic) et tout point d'accès compatible OpenAI. Testés contre des réponses enregistrées, **pas contre les vraies API** (aucune clé dans l'environnement de développement) |
| Budget quotidien LLM | ✅ | Appel refusé une fois le budget atteint, sans contacter le fournisseur |
| Trois niveaux d'autonomie | 🟡 | Recherche et Simulation fonctionnels ; Réel verrouillé côté serveur (aucune venue réelle) |

## 3. Risk Engine

| Contrôle | État |
| --- | --- |
| Risque maximal par trade | ✅ |
| Exposition totale, taille de position | ✅ |
| Drawdown maximal, perte journalière | ✅ (bascule automatique en RÉDUCTION / ARRÊT) |
| Stop-loss obligatoire, distance minimale (ATR) et maximale | ✅ |
| Positions simultanées | ✅ |
| Corrélation entre positions | ✅ (60 bougies de rendements log) |
| Liquidité, part du volume | ✅ |
| Spread | ✅ si la cotation fournit bid/ask (Coinbase) ; sinon contrôle signalé « non vérifiable » |
| Volatilité (ATR %) | ✅ |
| Pertes consécutives et pause | ✅ |
| Nouveaux ordres par jour | ✅ |
| Fraîcheur des données | ✅ |
| Confiance minimale, rapport gain/risque | ✅ |
| Plafonds en dur non contournables | ✅ (schéma : une valeur au-delà est rejetée) |
| Desserrer une limite exige une ré-authentification | ✅ |
| Coupe-circuit ACTIF / RÉDUCTION / ARRÊT | ✅ ; freiner est immédiat, reprendre exige le mot de passe |
| Arrêt d'urgence au niveau du déploiement | ✅ variable `KILL_SWITCH=halt`, prioritaire sur l'état stocké |
| Les freins (stops, clôtures manuelles) passent même à l'arrêt | ✅ |

## 4. Données, graphiques, simulation

| Exigence | État | Détail |
| --- | --- | --- |
| Données de marché réelles | 🟡 | Adaptateurs Coinbase, Kraken et Alpha Vantage écrits et testés sur des réponses au format réel ; **pas appelés en direct** ici (hôtes bloqués par le réseau du bac à sable). Le parcours e2e utilise un historique réel enregistré |
| Bougies clôturées uniquement | ✅ | La bougie en cours n'est jamais utilisée ni affichée comme un fait |
| Graphique pro : chandeliers, volume, indicateurs, entrée/stop/objectif, positions | ✅ | lightweight-charts v5, volume en panneau séparé, vue tableau |
| Courbe de capital et drawdown | ✅ | Deux panneaux, jamais deux axes |
| Simulation avec frais et glissement | ✅ | Même simulateur pour le paper et le backtest |
| Surveillance des stops et objectifs | ✅ toutes les 15 min pour la crypto ; quotidienne pour les actions (limite du fournisseur gratuit) |

## 5. Backtesting et mémoire

| Exigence | État | Détail |
| --- | --- | --- |
| Moteur de backtest événementiel | ✅ code et tests | Exécution à l'ouverture suivante, stop prioritaire si stop et objectif touchés |
| Segments TRAIN / VALIDATION / TEST / OOS avec embargo | ✅ code et tests | |
| Métriques | ✅ | Ratios annualisés masqués sous 30 observations (jamais de chiffre trompeur) |
| Écran de backtest, comparaison de stratégies | ⏳ V0.3 | L'écran le dit explicitement ; aucun résultat fictif |
| Mémoire des décisions | ✅ | Données disponibles au moment de la décision, rapports, échange exact avec le modèle, décision, confiance, paramètres de risque, verdict, ordre, exécution, coût ; jamais effacée |
| Résultat et P&L rattachés à chaque décision | 🟡 | Les trades clos portent leur P&L et le lien vers la décision ; le règlement des décisions non exécutées (HOLD, refus) est prévu en V0.3 |
| Apprentissage sur les erreurs | ⏳ V0.3 | Aucun apprentissage automatique ; toute optimisation devra être validée hors échantillon |
| Reinforcement learning | ❌ | Non ajouté : aucune justification mesurée à ce stade (voir `audit/04-finrl.md`) |

## 6. Sécurité

| Exigence | État | Détail |
| --- | --- | --- |
| Aucune clé, secret ou mot de passe dans le frontend | ✅ | Secrets du Worker uniquement ; test d'architecture qui cherche des motifs de clés dans les sources |
| Mots de passe | ✅ | PBKDF2-SHA-256, 100 000 itérations (maximum du Worker), sel aléatoire |
| Sessions | ✅ | Cookie `__Host-`, HttpOnly, Secure, SameSite=Strict ; seule l'empreinte SHA-256 est stockée |
| Protection CSRF | ✅ | En-tête client obligatoire et contrôle de l'origine |
| Limitation des tentatives, verrouillage | ✅ | 5 échecs sur un compte, 10 par IP sur 15 minutes |
| Journalisation des opérations | ✅ | Connexions, modes, limites, coupe-circuit, ordres, erreurs des tâches |
| Clés de trading à permissions minimales, retraits désactivés | ⏳ V1 | Sans objet en V0.1 : aucune clé de trading n'existe |
| Mode réel impossible par accident | ✅ | Refusé par le serveur ; conditions affichées ; exigera une variable de déploiement, une venue configurée, une ré-authentification et une phrase de confirmation |

## 7. Produit

| Exigence | État |
| --- | --- |
| PWA installable sur iPhone (icônes, plein écran, zones sûres, thème) | ✅ |
| Qualité d'interface au niveau de BoxingCoach | ✅ vérifiée sur captures iPhone (sombre et clair) ; à juger sur un appareil réel |
| Dashboard Marché / IA / Portefeuille / Activité | ✅ |
| Déploiement GitHub → Cloudflare | 🟡 configuration prête et documentée ; le premier déploiement doit être fait depuis votre compte Cloudflare |
