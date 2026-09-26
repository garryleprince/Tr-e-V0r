import type { LlmSettings } from '../../core/domain/settings';
import type { RuntimeConfig } from '../env';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatibleProvider } from './openai-compatible';
import type { LlmProvider, LlmTier, StructuredRequest, StructuredResult } from './types';

/**
 * LLM gateway: builds the configured provider and enforces the daily budget
 * BEFORE every call (Condor's LLM cost cap). The spend of the current run is
 * added to the day's recorded spend so that a single run cannot overshoot.
 */

export type LlmAvailability =
  | { readonly available: true; readonly provider: LlmProvider }
  | { readonly available: false; readonly reason: string };

export function buildLlmProvider(settings: LlmSettings, config: RuntimeConfig, fetcher?: typeof fetch): LlmAvailability {
  const models: Record<LlmTier, string> = { deep: settings.deepModel, quick: settings.quickModel };
  const efforts = { deep: settings.deepEffort, quick: settings.quickEffort };
  switch (settings.provider) {
    case 'disabled':
      return { available: false, reason: 'IA désactivée dans les réglages' };
    case 'anthropic':
      if (!config.keys.anthropic) return { available: false, reason: 'clé ANTHROPIC_API_KEY non configurée' };
      return {
        available: true,
        provider: new AnthropicProvider({ apiKey: config.keys.anthropic, models, efforts, ...(fetcher ? { fetch: fetcher } : {}) }),
      };
    case 'openai-compatible':
      if (!settings.baseUrl) return { available: false, reason: 'URL du fournisseur OpenAI-compatible non renseignée' };
      return {
        available: true,
        provider: new OpenAICompatibleProvider({
          baseUrl: settings.baseUrl,
          apiKey: config.keys.openaiCompatible,
          models,
          efforts,
          ...(fetcher ? { fetch: fetcher } : {}),
        }),
      };
  }
}

export class BudgetedLlm implements LlmProvider {
  private spentThisRun = 0;

  constructor(
    private readonly inner: LlmProvider,
    private readonly dailyBudgetUsd: number,
    private readonly spentTodayUsd: number,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  model(tier: LlmTier): string {
    return this.inner.model(tier);
  }

  get runSpendUsd(): number {
    return this.spentThisRun;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const spent = this.spentTodayUsd + this.spentThisRun;
    if (spent >= this.dailyBudgetUsd) {
      return {
        ok: false,
        error: {
          kind: 'budget_exceeded',
          message: `budget IA du jour atteint (${spent.toFixed(2)} $ / ${this.dailyBudgetUsd.toFixed(2)} $)`,
        },
      };
    }
    const result = await this.inner.generateStructured(req);
    if (result.usage) this.spentThisRun += result.usage.costUsd;
    return result;
  }
}
