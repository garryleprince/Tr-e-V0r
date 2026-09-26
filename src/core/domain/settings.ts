import { z } from 'zod';
import { DEFAULT_RISK_LIMITS, HARD_CAPS, RiskLimitsSchema } from '../risk/limits';
import { TimeframeSchema } from './time';

/**
 * Application settings, stored as validated JSON in D1 (`settings` table).
 * Secrets (API keys) are NEVER settings: they are Worker secrets.
 */

export const WatchlistSettingsSchema = z.strictObject({
  instrumentIds: z.array(z.string().min(3)).min(1).max(12),
  /** Timeframe of the analysis cycle and the default chart. */
  timeframe: TimeframeSchema,
});
export type WatchlistSettings = z.infer<typeof WatchlistSettingsSchema>;

export const LLM_PROVIDERS = ['anthropic', 'openai-compatible', 'disabled'] as const;
export const EffortSchema = z.enum(['low', 'medium', 'high']);

export const LlmSettingsSchema = z.strictObject({
  provider: z.enum(LLM_PROVIDERS),
  /** Trader (decision) model. */
  deepModel: z.string().min(1).max(100),
  /** Analyst model. */
  quickModel: z.string().min(1).max(100),
  deepEffort: EffortSchema,
  quickEffort: EffortSchema,
  /** Base URL of an OpenAI-compatible endpoint (GPT, Gemini, Ollama, vLLM…). */
  baseUrl: z.string().url().max(300).nullable(),
  dailyBudgetUsd: z.number().min(0).max(HARD_CAPS.llmDailyBudgetUsd),
  /** When the LLM fails, fall back to the rule-based agents (explicit opt-in). */
  fallbackToRules: z.boolean(),
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

export const ScheduleSettingsSchema = z.strictObject({
  /** Daily analysis cycle of the watchlist (cron). Monitoring always runs. */
  analysisEnabled: z.boolean(),
});
export type ScheduleSettings = z.infer<typeof ScheduleSettingsSchema>;

export const CostSettingsSchema = z.strictObject({
  feeBps: z.number().min(0).max(200),
  slippageBps: z.number().min(0).max(200),
  minFee: z.number().min(0).max(100),
});
export type CostSettings = z.infer<typeof CostSettingsSchema>;

export const SettingsSchema = z.strictObject({
  risk: RiskLimitsSchema,
  watchlist: WatchlistSettingsSchema,
  llm: LlmSettingsSchema,
  schedule: ScheduleSettingsSchema,
  costs: CostSettingsSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  risk: DEFAULT_RISK_LIMITS,
  watchlist: {
    instrumentIds: ['coinbase:BTC-USD', 'coinbase:ETH-USD', 'coinbase:SOL-USD'],
    timeframe: '1d',
  },
  llm: {
    provider: 'anthropic',
    deepModel: 'claude-opus-5',
    quickModel: 'claude-opus-5',
    deepEffort: 'high',
    quickEffort: 'low',
    baseUrl: null,
    dailyBudgetUsd: 2,
    fallbackToRules: false,
  },
  schedule: { analysisEnabled: true },
  costs: { feeBps: 10, slippageBps: 5, minFee: 0 },
};

export const PAPER_STARTING_CASH = 10_000;
