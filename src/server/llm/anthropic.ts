import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { costUsd, type TokenCounts } from './pricing';
import type { Effort, LlmProvider, LlmTier, LlmUsage, StructuredRequest, StructuredResult } from './types';

/**
 * Claude, through the official Anthropic SDK (fetch-based, runs on Workers).
 *
 * - Structured outputs (`output_config.format`) from the agent's zod schema;
 *   the caller re-validates with the strict domain schema.
 * - Adaptive thinking; effort per tier (decision agent deeper than analysts).
 * - Server-side refusal fallback (`fallbacks: "default"`): a policy decline is
 *   retried on Anthropic's recommended model inside the same call. A refusal
 *   that survives the chain is reported as `refusal`, never read as content.
 * - The stable system prompt is marked cacheable.
 */

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly models: Readonly<Record<LlmTier, string>>;
  readonly efforts: Readonly<Record<LlmTier, Effort>>;
  /** Injected in tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 2,
      timeout: 60_000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  model(tier: LlmTier): string {
    return this.opts.models[tier];
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.model(req.tier);
    const started = Date.now();
    try {
      const msg = await this.client.beta.messages.parse({
        model,
        max_tokens: req.maxOutputTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: this.opts.efforts[req.tier], format: betaZodOutputFormat(req.schema) },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
      });
      const usage = this.usage(msg, model, Date.now() - started);
      const raw = msg.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();

      if (msg.stop_reason === 'refusal') {
        const category = msg.stop_details?.category ?? 'non précisée';
        return { ok: false, error: { kind: 'refusal', message: `refus du modèle (catégorie : ${category})` }, usage, raw };
      }
      if (msg.stop_reason === 'max_tokens') {
        return { ok: false, error: { kind: 'invalid_output', message: 'réponse tronquée (limite de tokens)' }, usage, raw };
      }
      const parsed = msg.parsed_output;
      if (parsed === null || parsed === undefined) {
        return { ok: false, error: { kind: 'invalid_output', message: 'sortie structurée absente ou invalide' }, usage, raw };
      }
      return { ok: true, value: parsed as T, usage, raw };
    } catch (err) {
      return { ok: false, error: classify(err) };
    }
  }

  private usage(msg: Anthropic.Beta.BetaMessage, requested: string, latencyMs: number): LlmUsage {
    const iterations = msg.usage.iterations ?? [];
    let cost = 0;
    let estimated = false;
    let input = 0;
    let output = 0;
    const counted = iterations.length > 0 ? iterations : [msg.usage];
    for (const it of counted) {
      const tokens: TokenCounts = {
        input: it.input_tokens ?? 0,
        cacheWrite: it.cache_creation_input_tokens ?? 0,
        cacheRead: it.cache_read_input_tokens ?? 0,
        output: 'output_tokens' in it ? Number(it.output_tokens ?? 0) : 0,
      };
      const itModel = 'model' in it && typeof it.model === 'string' ? it.model : msg.model ?? requested;
      const c = costUsd(itModel, tokens);
      cost += c.cost;
      estimated ||= c.estimated;
      input += tokens.input + tokens.cacheWrite + tokens.cacheRead;
      output += tokens.output;
    }
    return {
      provider: this.id,
      model: msg.model ?? requested,
      inputTokens: input,
      outputTokens: output,
      costUsd: cost,
      costEstimated: estimated,
      latencyMs,
    };
  }
}

function classify(err: unknown): { kind: 'rate_limited' | 'transport' | 'not_configured' | 'invalid_output'; message: string } {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'not_configured', message: 'clé Anthropic refusée' };
  }
  if (err instanceof Anthropic.RateLimitError) return { kind: 'rate_limited', message: 'limite de requêtes Anthropic' };
  if (err instanceof Anthropic.BadRequestError) return { kind: 'invalid_output', message: `requête refusée : ${err.message.slice(0, 200)}` };
  if (err instanceof Anthropic.APIError) return { kind: 'transport', message: `Anthropic ${err.status ?? ''} ${err.message.slice(0, 200)}`.trim() };
  return { kind: 'transport', message: err instanceof Error ? err.message.slice(0, 200) : String(err) };
}
