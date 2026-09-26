# Agents IA, abstraction LLM et autonomie

## 1. Principe : l'IA propose, le code dispose

Inspiré de Condor (« LLMs are powerful reasoners but terrible at the mechanical
parts of trading ») et de TradingAgents (snapshot vérifié) :

| Responsabilité | Porteur | Jamais |
| --- | --- | --- |
| Chiffres (prix, indicateurs, niveaux, volatilité) | Moteur quantitatif | Le LLM ne calcule ni n'invente un chiffre de marché |
| Interprétation, scénarios, facteurs, justification | Agents IA | |
| Quantité, exposition | Portfolio Manager (code) | Le LLM ne fixe pas la quantité finale |
| Acceptation, réduction, refus | Risk Engine (code) | Le LLM ne peut ni l'appeler, ni le configurer, ni le contourner |
| Ordre | Execution Engine (code) | Le LLM n'a aucun outil |

Le LLM reçoit des **données** et renvoie des **données** validées par schéma.
Il n'a accès à aucun outil, aucun réseau, aucune fonction.

---

## 2. Contrats

Tous les types sont définis avec zod dans `src/core/domain/` et partagés par le
serveur et le frontend.

### 2.1 Contexte d'analyse

```ts
interface AnalysisContext {
  instrument: Instrument;        // identité résolue de façon déterministe (TradingAgents #814)
  timeframe: Timeframe;          // '1h' | '4h' | '1d'
  asOf: number;                  // clôture de la dernière bougie FERMÉE (ms UTC)
  candles: Candle[];             // fenêtre ≤ asOf, jamais au-delà
  snapshot: TechnicalSnapshot;   // features calculées par core/quant
  position: PositionView | null; // position actuelle sur l'actif
  portfolio: PortfolioView;      // equity, exposition, positions ouvertes
}
```

### 2.2 Rapport d'agent

```ts
interface AgentReport {
  agent: 'technical' | 'fundamental' | 'sentiment' | 'macro';
  status: 'ok' | 'unavailable' | 'error';     // absence ≠ avis neutre (TradingAgents report_or_absent)
  stance: 'bullish' | 'bearish' | 'neutral' | null;
  confidence: number | null;                    // 0..1
  summary: string;                              // court, destiné à l'humain et au Trader
  details: Record<string, unknown>;             // niveaux clés, signaux, risques…
  source: 'llm' | 'rules' | 'none';
  llm?: { provider; model; inputTokens; outputTokens; costUsd; latencyMs };
  unavailableReason?: string;                   // ex. « aucun fournisseur fondamental connecté »
}
```

### 2.3 Proposition du Trader

```ts
interface TradeProposal {
  action: 'BUY' | 'SELL' | 'HOLD';     // BUY = ouvrir/renforcer un long ; SELL = réduire/clôturer un long
  confidence: number;                   // 0..1
  entryPrice: number | null;            // prix de référence envisagé
  stopLoss: number | null;              // obligatoire pour BUY (vérifié par le Risk Engine)
  takeProfit: number | null;
  horizonBars: number | null;           // horizon en bougies de l'unité analysée
  sizePctOfEquity: number | null;       // SUGGESTION ; la quantité finale est calculée par le code
  mainScenario: Scenario;               // { title, description, probability }
  altScenario: Scenario;
  keyFactors: KeyFactor[];              // { factor, direction, weight } — 6 au plus
  invalidation: string;                 // ce qui prouverait que la thèse est fausse
  rationale: string;                    // justification structurée, courte
}
```

**V0.1 : long uniquement.** SELL signifie réduire ou clôturer une position
longue. La vente à découvert exige une venue avec marge et des règles de risque
spécifiques : elle est prévue plus tard et explicitement refusée d'ici là.

### 2.4 Validation après génération

Même valide pour le schéma, une proposition est **contrôlée** avant d'aller plus
loin (`core/agents/sanity.ts`) :

- `entryPrice` à ±2 % du dernier prix de référence (bande de prix, comme la price protection de Nautilus) ;
- pour un BUY : `stopLoss < entryPrice < takeProfit` ;
- niveaux positifs et finis ;
- probabilités des scénarios entre 0 et 1.

Si la proposition échoue, la décision est enregistrée avec le statut **`INVALID`**
et ses raisons. Il n'y a **jamais** de repli silencieux vers HOLD (sentinelle
`REVIEW` de TradingAgents).

---

## 3. Les agents

| Agent | V0.1 | Source | Détail |
| --- | --- | --- | --- |
| **Technical Analyst** | ✅ | LLM si configuré, sinon règles | Reçoit le `TechnicalSnapshot` ; interprète tendance, momentum, volatilité, supports et résistances, configurations |
| **Fundamental Analyst** | ⏳ V0.2 | — | En V0.1 : `status: 'unavailable'`, raison explicite. Non applicable aux cryptos. Sources prévues : Alpha Vantage (OVERVIEW, EARNINGS), SEC EDGAR « as filed » |
| **Sentiment Analyst** | ⏳ V0.2 | — | En V0.1 : `unavailable`. Source prévue : Alpha Vantage `NEWS_SENTIMENT`, filtré par date (`as_of`) |
| **Market/Macro Analyst** | ⏳ V0.2 | — | En V0.1 : `unavailable`. Sources prévues : FRED (taux, inflation), indices (SPY, QQQ, DXY), corrélations |
| **Consensus** | ✅ | Code | Agrégation des avis disponibles pondérée par la confiance ; taux d'accord ; les absents sont listés |
| **Trader Agent** | ✅ | LLM si configuré, sinon règles | Produit la `TradeProposal` |
| **Portfolio Manager** | ✅ | **Code** | Convertit la proposition en intention d'ordre : quantité à risque fixe, plafonds de position et de cash, logique d'ajout, de réduction et de clôture |
| **Risk Manager** | ✅ | **Code** | Voir [`RISQUE_ET_SECURITE.md`](RISQUE_ET_SECURITE.md) |

### 3.1 Agents à règles (base de référence déterministe)

Chaque agent LLM a un équivalent **déterministe** (`core/agents/rules/`) :

- l'application fonctionne sans clé LLM, clairement étiquetée « Analyse quantitative (sans IA) » ;
- il sert de **référence** : le LLM doit faire mieux hors échantillon, sinon il n'apporte rien ;
- il est rejouable en backtest (déterministe, gratuit).

Trader à règles (V0.1) : suivi de tendance avec stop ATR.

- **BUY** : régime haussier, score technique ≥ 0,3, RSI < 70 et volatilité non extrême.
  Stop à 2 × ATR sous l'entrée, objectif à 3 × ATR au-dessus, horizon de 10 bougies.
- **SELL** : position détenue et (régime baissier ou score ≤ −0,3).
- **HOLD** : sinon.

Ce n'est **pas une stratégie prometteuse**. C'est une base honnête et mesurable.

### 3.2 Si l'agent LLM échoue

Refus du modèle, sortie invalide, erreur réseau ou budget dépassé : le rapport
est `error` et la décision `INVALID`. Le repli vers l'agent à règles est une
**option explicite**, désactivée par défaut (`llm.fallbackToRules`), pour
qu'un changement de source de décision ne passe jamais inaperçu.

### 3.3 Communication entre agents

Contrairement à TradingAgents (prose intégrale transmise à tous), les agents
échangent des **objets structurés courts** : `AgentReport.summary` +
`details`. Le Trader reçoit le snapshot chiffré, les rapports et le consensus,
pas un historique de conversation. Coût maîtrisé ; une erreur d'un agent reste
identifiable dans son rapport.

### 3.4 Évolutions prévues

- **V0.2** : analystes Fondamental, Sentiment et Macro ; **débat consultatif**
  haussier/baissier optionnel et plafonné en tokens (inspiré de TradingAgents).
  Son résultat alimente le Trader, jamais le Risk Engine.
- **V0.3** : mémoire — les décisions réglées et leurs statistiques sont
  disponibles à l'analyse (voir § 6).
- **V1+** : `SignalModel` issu du labo hors ligne (ML), validé hors échantillon.

---

## 4. Abstraction LLM

### 4.1 Interface

```ts
interface LLMProvider {
  readonly id: 'anthropic' | 'openai-compatible' | 'disabled' | string;
  readonly capabilities: { structuredOutput: 'native' | 'json-mode' | 'prompt-only' };
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

interface StructuredRequest<T> {
  tier: 'deep' | 'quick';        // deep = Trader ; quick = analystes (TradingAgents)
  system: string;                // stable → mis en cache côté fournisseur
  user: string;                  // données de l'analyse (JSON)
  schema: ZodType<T>;            // validation systématique de la sortie
  schemaName: string;
  maxOutputTokens: number;
}

type StructuredResult<T> =
  | { ok: true;  value: T; usage: LLMUsage; raw: string }
  | { ok: false; error: { kind: 'refusal' | 'invalid_output' | 'transport' | 'rate_limited'
                                 | 'not_configured' | 'budget_exceeded'; message: string };
      usage?: LLMUsage };
```

**Aucun type d'un fournisseur ne sort de son adaptateur.** Le reste de
l'application ne voit que cette interface. Changer de LLM revient à changer
`settings.llm.provider` : aucune modification de code.

### 4.2 Adaptateurs

| Adaptateur | Couvre | Sorties structurées | État V0.1 |
| --- | --- | --- | --- |
| `anthropic` | Claude | natives (`output_config.format` + schéma JSON dérivé de zod) | ✅ implémenté ; testé avec des réponses simulées (pas de clé dans l'environnement de développement) |
| `openai-compatible` | OpenAI (GPT), Google Gemini (endpoint compatible OpenAI), Ollama, vLLM, LM Studio, OpenRouter | `response_format: json_schema` | ✅ implémenté ; testé avec des réponses simulées |
| `disabled` | — | — | ✅ renvoie `not_configured` ; les agents à règles prennent le relais |
| `workers-ai`, `bedrock`, Gemini natif | — | — | ⏳ prévus |

### 4.3 Claude, cerveau par défaut

| Paramètre | Valeur par défaut | Raison |
| --- | --- | --- |
| Modèle deep et quick | `claude-opus-5` | Modèle recommandé ; les deux niveaux sont configurables (par exemple `claude-sonnet-5` pour quick) |
| Réflexion | adaptative (`thinking: { type: "adaptive" }`) | Le modèle décide de la profondeur |
| Effort | `high` pour le Trader, `low` pour les analystes | Répartition du coût là où la décision se prend |
| Sorties structurées | `output_config.format` (schéma JSON) + validation zod | Double garantie |
| Refus | `stop_reason: "refusal"` traité avant toute lecture ; repli serveur `fallbacks: "default"` activé (bêta `server-side-fallback-2026-07-01`) | Un refus ne doit ni planter ni être pris pour une décision |
| Cache de prompt | prompt système stable, marqué `cache_control` | Coût réduit sur les appels répétés, quand le préfixe dépasse le minimum cacheable |
| Réessais | SDK : 2 réessais sur 408, 409, 429 et 5xx ; délai maximal 60 s | Robustesse |
| Clé | secret Worker `ANTHROPIC_API_KEY` | Jamais côté client |

### 4.4 Passerelle LLM (budget et audit)

`LLMGateway` enveloppe tout fournisseur :

1. **Avant l'appel** : vérifie le budget journalier (dépense du jour en D1,
   comparée au plafond). S'il est dépassé, renvoie `budget_exceeded` sans appeler.
2. **Après l'appel** : calcule le coût (table de prix par modèle, modifiable) et
   l'enregistre avec les tokens et la latence.
3. **Toujours** : conserve le prompt et la réponse brute dans le rapport d'agent
   (audit complet, comme les snapshots par tick de Condor).

---

## 5. Autonomie progressive

| | Niveau 1 — ANALYSE (`RESEARCH`) | Niveau 2 — PAPER (`PAPER`) | Niveau 3 — LIVE (`LIVE`) |
| --- | --- | --- | --- |
| Analyse multi-agents | ✅ | ✅ | ✅ |
| Proposition de trade | ✅ enregistrée | ✅ | ✅ |
| Risk Engine | ✅ évalué, pour information | ✅ décisionnel | ✅ décisionnel, contrôle absolu |
| Exécution | ❌ jamais | ✅ simulée | ✅ réelle |
| Activation | par défaut ou retour libre | confirmation | 5 conditions cumulatives, voir `ARCHITECTURE.md` § 10 |
| Disponible en V0.1 | ✅ | ✅ | ❌ (403, aucun code de venue réelle) |

**Gouvernance commune** (inspirée de Condor) :

- si le kill switch est `HALTED`, les cycles planifiés **n'appellent pas le LLM**
  (économie et sûreté) ; seule l'analyse manuelle reste possible, sans exécution ;
- budget LLM atteint : l'analyse continue avec les agents à règles seulement si
  `fallbackToRules` est activé, sinon le cycle s'arrête et le signale ;
- le mode est une donnée **stockée et journalisée**, jamais déduite d'une URL ou
  de la présence d'une clé (contre-exemple : FinRL-X).

---

## 6. Mémoire et apprentissage contrôlé

L'exigence est double : tout conserver pour comprendre les erreurs, mais
**n'activer aucun apprentissage à l'aveugle**.

| Étape | V0.1 | Prévu |
| --- | --- | --- |
| Conserver le contexte complet de chaque décision | ✅ (voir `ARCHITECTURE.md` § 6) | |
| Lier décision, ordre, fill, position et résultat | ✅ | |
| Règlement à l'horizon : rendement, MFE/MAE, stop ou objectif touché | partiel (positions clôturées) | V0.3 : décisions non exécutées aussi (« qu'aurait donné ce HOLD ? ») |
| Étiquetage des erreurs (stop trop serré, contre-tendance, volatilité…) | | V0.3 |
| Fiabilité par confiance, régime, actif, niveau de consensus | | V0.3 (répond à « dans quelles conditions l'agent est-il fiable ? ») |
| Réflexion LLM sur une décision réglée | | V0.3, **proposée**, jamais réinjectée automatiquement |
| Réinjection de leçons dans les prompts | | Seulement derrière un réglage explicite, **filtrée point-in-time** (TradingAgents #1251) et après validation hors échantillon (voir `BACKTESTING.md`) |
