import type { AgentId, AgentReport, Consensus, TradeProposal } from '../domain/analysis';
import type { Candle, Instrument } from '../domain/market';
import type { Timeframe } from '../domain/time';
import type { OpenPosition } from '../domain/trading';
import type { TechnicalSnapshot } from '../quant/features';

/**
 * Agent contracts. Any agent — rules, Claude, GPT, a local model, a future ML
 * model — implements one of these interfaces and can be swapped without
 * touching the orchestrator.
 */

/** What an agent may know about the account. Never secrets, never venue handles. */
export interface PortfolioView {
  readonly equity: number;
  readonly cash: number;
  readonly grossExposure: number;
  readonly openPositions: readonly Pick<OpenPosition, 'instrumentId' | 'quantity' | 'avgPrice'>[];
}

export interface AnalysisContext {
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  /** Close time of the last closed bar. Nothing after it is visible. */
  readonly asOf: number;
  readonly candles: readonly Candle[];
  readonly snapshot: TechnicalSnapshot;
  /** Current position on this instrument, if any. */
  readonly position: OpenPosition | null;
  readonly portfolio: PortfolioView;
}

export interface AnalystAgent {
  readonly id: AgentId;
  analyze(ctx: AnalysisContext): Promise<AgentReport>;
}

export interface TraderInput {
  readonly ctx: AnalysisContext;
  readonly reports: readonly AgentReport[];
  readonly consensus: Consensus;
}

export type TraderOutcome =
  | {
      readonly ok: true;
      readonly proposal: TradeProposal;
      readonly source: 'llm' | 'rules';
      readonly llm?: AgentReport['llm'];
      readonly transcript?: AgentReport['transcript'];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly source: 'llm' | 'rules';
      readonly llm?: AgentReport['llm'];
      readonly transcript?: AgentReport['transcript'];
    };

export interface TraderAgent {
  readonly source: 'llm' | 'rules';
  propose(input: TraderInput): Promise<TraderOutcome>;
}

/**
 * Reserved slot for a statistical model trained offline (docs/ARCHITECTURE.md
 * §5). No implementation ships in V0.1: a model is only plugged in after it has
 * beaten the rule-based baseline out of sample.
 */
export interface SignalModel {
  readonly id: string;
  readonly version: string;
  /** Returns a score in [-1, 1] from features known at `asOf`. */
  score(snapshot: TechnicalSnapshot): number;
}
