import { z } from 'zod';

/**
 * Contracts exchanged between agents.
 *
 * Two families of schemas live here:
 * - *domain* schemas (strict bounds) validate everything that enters the
 *   decision path, whatever produced it;
 * - *wire* schemas (`*WireSchema`) are the shapes a language model is asked to
 *   produce. They carry no numeric bounds, because providers' structured-output
 *   dialects do not all enforce them; the domain schema is applied afterwards.
 */

export const AgentIdSchema = z.enum(['technical', 'fundamental', 'sentiment', 'macro']);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const StanceSchema = z.enum(['bullish', 'bearish', 'neutral']);
export type Stance = z.infer<typeof StanceSchema>;

export const AGENT_LABELS: Readonly<Record<AgentId, string>> = {
  technical: 'Analyste technique',
  fundamental: 'Analyste fondamental',
  sentiment: 'Analyste sentiment',
  macro: 'Analyste macro',
};

export interface LlmCallInfo {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
}

/**
 * An agent's report. `status` distinguishes "this agent had nothing to say"
 * from "this agent could not run" — an absent report must never be read as a
 * neutral one (TradingAgents' report_or_absent).
 */
export interface AgentReport {
  readonly agent: AgentId;
  readonly status: 'ok' | 'unavailable' | 'error';
  readonly stance: Stance | null;
  readonly confidence: number | null;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly source: 'llm' | 'rules' | 'none';
  readonly llm?: LlmCallInfo;
  readonly unavailableReason?: string;
  readonly error?: string;
  /** Exact prompt sent and raw text received, kept for the audit trail. */
  readonly transcript?: { readonly system: string; readonly user: string; readonly raw: string };
}

// ---------------------------------------------------------------- technical

export const TechnicalReportWireSchema = z.strictObject({
  stance: StanceSchema.describe('Lecture directionnelle globale de la situation technique.'),
  confidence: z
    .number()
    .describe('Confiance entre 0 et 1 dans cette lecture, compte tenu de la qualité des signaux.'),
  summary: z
    .string()
    .describe('Synthèse en 2 à 4 phrases, en français, qui ne cite que des chiffres fournis.'),
  keyLevels: z
    .array(
      z.strictObject({
        label: z.string(),
        price: z.number().describe('Niveau de prix repris du snapshot, jamais inventé.'),
        kind: z.enum(['support', 'resistance', 'pivot']),
      }),
    )
    .describe('Au plus 4 niveaux, tous issus du snapshot fourni.'),
  signals: z
    .array(
      z.strictObject({
        name: z.string(),
        reading: z.string(),
        implication: z.enum(['bullish', 'bearish', 'neutral']),
      }),
    )
    .describe('Au plus 6 signaux, chacun rattaché à un indicateur du snapshot.'),
  risks: z.array(z.string()).describe('Au plus 3 risques techniques identifiés.'),
});

export const TechnicalReportSchema = TechnicalReportWireSchema.extend({
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(1200),
  keyLevels: TechnicalReportWireSchema.shape.keyLevels.max(6),
  signals: TechnicalReportWireSchema.shape.signals.max(8),
  risks: z.array(z.string().max(300)).max(5),
});
export type TechnicalReportPayload = z.infer<typeof TechnicalReportSchema>;

// ------------------------------------------------------------------ proposal

export const TradeActionSchema = z.enum(['BUY', 'SELL', 'HOLD']);
export type TradeAction = z.infer<typeof TradeActionSchema>;

const ScenarioWire = z.strictObject({
  title: z.string(),
  description: z.string(),
  probability: z.number().describe('Probabilité subjective entre 0 et 1.'),
});

const KeyFactorWire = z.strictObject({
  factor: z.string(),
  direction: StanceSchema,
  weight: z.number().describe('Importance relative entre 0 et 1.'),
});

export const TradeProposalWireSchema = z.strictObject({
  action: TradeActionSchema.describe(
    'BUY = ouvrir ou renforcer une position longue ; SELL = réduire ou clôturer une position longue existante ; HOLD = ne rien faire. La vente à découvert est interdite.',
  ),
  confidence: z.number().describe('Confiance entre 0 et 1.'),
  entryPrice: z
    .number()
    .nullable()
    .describe('Prix d’entrée envisagé, proche du dernier cours fourni. null pour HOLD.'),
  stopLoss: z
    .number()
    .nullable()
    .describe('Stop de protection en prix absolu. Obligatoire pour BUY, sous le prix d’entrée.'),
  takeProfit: z.number().nullable().describe('Objectif en prix absolu, au-dessus de l’entrée pour BUY.'),
  horizonBars: z
    .number()
    .nullable()
    .describe('Horizon en nombre de bougies de l’unité de temps analysée.'),
  sizePctOfEquity: z
    .number()
    .nullable()
    .describe('Suggestion de taille en % du capital. Le système calcule la quantité finale.'),
  mainScenario: ScenarioWire,
  altScenario: ScenarioWire,
  keyFactors: z.array(KeyFactorWire).describe('Au plus 6 facteurs déterminants.'),
  invalidation: z.string().describe('Ce qui prouverait que la thèse est fausse.'),
  rationale: z.string().describe('Justification structurée et concise, en français.'),
});

const Scenario = ScenarioWire.extend({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
  probability: z.number().min(0).max(1),
});

export const TradeProposalSchema = TradeProposalWireSchema.extend({
  confidence: z.number().min(0).max(1),
  entryPrice: z.number().positive().nullable(),
  stopLoss: z.number().positive().nullable(),
  takeProfit: z.number().positive().nullable(),
  horizonBars: z.number().int().min(1).max(365).nullable(),
  sizePctOfEquity: z.number().min(0).max(100).nullable(),
  mainScenario: Scenario,
  altScenario: Scenario,
  keyFactors: z
    .array(
      KeyFactorWire.extend({ factor: z.string().min(1).max(200), weight: z.number().min(0).max(1) }),
    )
    .max(8),
  invalidation: z.string().min(1).max(600),
  rationale: z.string().min(1).max(2000),
});
export type TradeProposal = z.infer<typeof TradeProposalSchema>;
export type Scenario = z.infer<typeof Scenario>;

// ----------------------------------------------------------------- consensus

export interface Consensus {
  /** Confidence-weighted share of each stance among AVAILABLE reports (sums to 1). */
  readonly bullish: number;
  readonly bearish: number;
  readonly neutral: number;
  readonly dominant: Stance | null;
  /** Share of the dominant stance, 0..1. 1 = unanimous. */
  readonly agreement: number;
  readonly available: readonly AgentId[];
  readonly missing: readonly AgentId[];
}

// ------------------------------------------------------------------ decision

/**
 * Lifecycle of a decision in the journal.
 * - PROPOSED: produced, not yet through risk
 * - APPROVED / RESIZED / REJECTED: risk verdict
 * - EXECUTED: an order was filled
 * - NOT_EXECUTED: approved but not executed (research mode, HOLD, nothing to do)
 * - INVALID: the proposal failed validation or the agent failed — never a HOLD
 */
export const DecisionStatusSchema = z.enum([
  'PROPOSED',
  'APPROVED',
  'RESIZED',
  'REJECTED',
  'EXECUTED',
  'NOT_EXECUTED',
  'INVALID',
]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
