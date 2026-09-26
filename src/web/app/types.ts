import type { PerformanceMetrics } from '@core/backtest/metrics';
import type { AgentId, Consensus, DecisionStatus, TradeProposal } from '@core/domain/analysis';
import type { Candle, Instrument } from '@core/domain/market';
import type { Settings } from '@core/domain/settings';
import type { Timeframe } from '@core/domain/time';
import type { ClosedTrade, ExitReason, Mode, OpenPosition, TradingState } from '@core/domain/trading';
import type { TechnicalSnapshot } from '@core/quant/features';
import type { RiskCheck } from '@core/risk/engine';
import type { RiskLimits } from '@core/risk/limits';

/**
 * Shapes returned by the Worker API (src/server/http/routes-*.ts). The web
 * bundle never imports server code, so these mirror the responses; the e2e run
 * (tests/e2e/parcours.mjs) exercises every screen against the real API.
 */

export type { Candle, Instrument, Mode, TradingState, Timeframe, TechnicalSnapshot, RiskLimits, Settings, AgentId };

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface AuthStatus {
  readonly installed: boolean;
  readonly setupAvailable: boolean;
  readonly authenticated: boolean;
  readonly user: { readonly email: string } | null;
  readonly stepUpUntil: number;
}

export interface DeskView {
  readonly mode: Mode;
  readonly tradingState: TradingState;
  readonly effectiveState: TradingState;
  readonly forcedByDeployment: boolean;
  readonly reason: string | null;
  readonly updatedAt: number;
  readonly liveAvailable: boolean;
}

export interface WatchItemOk {
  readonly instrumentId: string;
  readonly instrument: Instrument;
  readonly last: number | null;
  readonly lastClose: number | null;
  readonly change1: number | null;
  readonly change20: number | null;
  readonly trend: 'up' | 'down' | 'range' | null;
  readonly volatilityRegime: 'low' | 'normal' | 'high' | null;
  readonly atrPct: number | null;
  readonly realizedVol20: number | null;
  readonly volumeZ20: number | null;
  readonly lastVolume: number | null;
  readonly technicalScore: number | null;
  readonly sparkline: number[];
  readonly asOf: number | null;
  readonly source: string;
  readonly quoteSource: string | null;
  readonly quoteTs: number | null;
  readonly warnings: string[];
  readonly error?: undefined;
}

export interface WatchItemError {
  readonly instrumentId: string;
  readonly instrument?: Instrument;
  readonly error: string;
}

export type WatchItem = WatchItemOk | WatchItemError;

export interface VerdictSummary {
  readonly id: string;
  readonly outcome: 'APPROVED' | 'RESIZED' | 'REJECTED' | string;
  readonly requestedQty: number;
  readonly approvedQty: number;
  readonly checks: RiskCheck[];
  readonly limits: RiskLimits | null;
  readonly tradingState: string;
  readonly summary: string;
}

export interface DecisionSummary {
  readonly id: string;
  readonly runId: string;
  readonly instrumentId: string;
  readonly mode: Mode;
  readonly action: 'BUY' | 'SELL' | 'HOLD' | null;
  readonly status: DecisionStatus;
  readonly source: 'llm' | 'rules';
  readonly confidence: number | null;
  readonly entryPrice: number | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly horizonBars: number | null;
  readonly referencePrice: number;
  readonly asOf: number;
  readonly createdAt: number;
  readonly proposal: TradeProposal | null;
  readonly invalidReasons: string[];
  readonly planExplanation: string | null;
  readonly executionNote: string | null;
  readonly verdict: VerdictSummary | null;
}

export interface RunSummary {
  readonly id: string;
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  readonly trigger: 'schedule' | 'manual';
  readonly mode: Mode;
  readonly status: 'running' | 'completed' | 'failed' | 'skipped';
  readonly asOf: number | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error: string | null;
  readonly llmCostUsd: number;
  readonly decision: DecisionSummary | null;
}

export interface AgentReportRow {
  readonly agent: AgentId | 'trader';
  readonly status: 'ok' | 'unavailable' | 'error';
  readonly stance: 'bullish' | 'bearish' | 'neutral' | null;
  readonly confidence: number | null;
  readonly summary: string;
  readonly details: Record<string, unknown>;
  readonly source: 'llm' | 'rules' | 'none';
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
  readonly transcript: { system: string; user: string; raw: string } | null;
  readonly error: string | null;
}

export interface RunDetail {
  readonly run: RunSummary;
  readonly snapshot: TechnicalSnapshot | null;
  readonly consensus: Consensus | null;
  readonly dataSource: string | null;
  readonly reports: AgentReportRow[];
  readonly orders: {
    readonly id: string;
    readonly side: 'BUY' | 'SELL';
    readonly quantity: number;
    readonly status: string;
    readonly origin: string;
    readonly fillPrice: number | null;
    readonly fee: number | null;
    readonly slippageBps: number | null;
    readonly createdAt: number;
  }[];
}

export interface AnalysisOutcome {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'skipped';
  readonly decisionId: string | null;
  readonly decisionStatus: DecisionStatus | null;
  readonly note: string;
}

export interface MarkedPosition extends OpenPosition {
  readonly instrument: Instrument | null;
  readonly markPrice: number | null;
  readonly marketValue: number;
  readonly unrealizedPnl: number;
  readonly unrealizedPct: number;
}

export interface PortfolioReady {
  readonly initialized: true;
  readonly currency: string;
  readonly startingCash: number;
  readonly cash: number;
  readonly equity: number;
  readonly exposure: number;
  readonly exposurePct: number;
  readonly pnlTotal: number;
  readonly pnlTotalPct: number;
  readonly pnlDay: number;
  readonly pnlDayPct: number;
  readonly drawdownPct: number;
  readonly peakEquity: number;
  readonly consecutiveLosses: number;
  readonly positions: MarkedPosition[];
  readonly metrics: PerformanceMetrics;
  readonly riskLimits: RiskLimits;
  readonly riskUsage: {
    readonly openPositions: number;
    readonly maxOpenPositions: number;
    readonly exposurePct: number;
    readonly maxExposurePct: number;
    readonly drawdownPct: number;
    readonly maxDrawdownPct: number;
    readonly dayLossPct: number;
    readonly maxDayLossPct: number;
  };
  readonly resetAt: number;
}

export type Portfolio = PortfolioReady | { readonly initialized: false; readonly riskLimits: RiskLimits };

export interface AppEvent {
  readonly id: string;
  readonly ts: number;
  readonly type: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly actor: string;
  readonly title: string;
  readonly data: unknown;
  readonly acknowledgedAt: number | null;
}

export interface LlmStatus {
  readonly provider: Settings['llm']['provider'];
  readonly available: boolean;
  readonly reason: string | null;
  readonly deepModel: string;
  readonly quickModel: string;
  readonly spentTodayUsd: number;
  readonly dailyBudgetUsd: number;
}

export interface Dashboard {
  readonly desk: DeskView;
  readonly watchlist: WatchItem[];
  readonly portfolio: Portfolio;
  readonly latestDecision: DecisionSummary | null;
  readonly recentDecisions: DecisionSummary[];
  readonly activity: AppEvent[];
  readonly unreadAlerts: number;
  readonly llm: LlmStatus;
  readonly dataMode: 'live' | 'fixture';
  readonly dataNotice: string | null;
  readonly now: number;
}

export interface SeriesPoint {
  readonly t: number;
  readonly v: number;
}

export interface CandlesResponse {
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  readonly candles: Candle[];
  readonly indicators: {
    readonly sma50: SeriesPoint[];
    readonly sma200: SeriesPoint[];
    readonly bbUpper: SeriesPoint[];
    readonly bbLower: SeriesPoint[];
  };
  readonly snapshot: TechnicalSnapshot | null;
  readonly source: string;
  readonly fromCache: boolean;
  readonly warnings: string[];
  readonly asOf: number | null;
  readonly positions: OpenPosition[];
  readonly latestDecision: DecisionSummary | null;
}

export interface EquityResponse {
  readonly curve: { t: number; equity: number; cash: number; exposure?: number; drawdown: number }[];
  readonly drawdown: { t: number; drawdown: number }[];
}

export interface TradesResponse {
  readonly trades: (ClosedTrade & { id: string; exitReason: ExitReason })[];
  readonly orders: Record<string, unknown>[];
}

export interface SettingsResponse {
  readonly settings: Settings;
  readonly labels: { readonly risk: Record<keyof RiskLimits, string> };
  readonly instruments: Instrument[];
  readonly secrets: { readonly anthropic: boolean; readonly openaiCompatible: boolean; readonly alphaVantage: boolean };
}

export interface SessionRow {
  readonly id: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | null;
}

export interface SystemInfo {
  readonly version: string;
  readonly environment: string;
  readonly dataMode: 'live' | 'fixture';
  readonly liveTradingEnabled: boolean;
  readonly killSwitchForced: boolean;
  readonly jobs: { name: string; lastRunAt: number; lastStatus: string; detail: string | null }[];
  readonly llm: LlmStatus;
  readonly providers: { readonly alphaVantageKey: boolean };
}
