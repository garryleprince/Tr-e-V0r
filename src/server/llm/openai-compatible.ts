import { z } from 'zod';
import { costUsd } from './pricing';
import type { Effort, LlmProvider, LlmTier, StructuredRequest, StructuredResult } from './types';

/**
 * Any endpoint that speaks the OpenAI Chat Completions dialect: OpenAI (GPT),
 * Google Gemini (its OpenAI-compatible endpoint), OpenRouter, and self-hosted
 * servers (Ollama, vLLM, LM Studio) reachable from the Worker.
 *
 * Structured output uses `response_format: json_schema` (strict). Servers that
 * ignore it still have their answer validated by the schema on our side.
 */

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly models: Readonly<Record<LlmTier, string>>;
  readonly efforts: Readonly<Record<LlmTier, Effort>>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id = 'openai-compatible';
  constructor(private readonly opts: OpenAICompatibleOptions) {}

  model(tier: LlmTier): string {
    return this.opts.models[tier];
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.model(req.tier);
    const started = Date.now();
    const fetcher = this.opts.fetch ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = {
      model,
      max_tokens: req.maxOutputTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, strict: true, schema: z.toJSONSchema(req.schema) },
      },
    };
    let res: Response;
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      return { ok: false, error: { kind: 'transport', message: err instanceof Error ? err.message : String(err) } };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: { kind: 'not_configured', message: 'clé refusée' } };
    if (res.status === 429) return { ok: false, error: { kind: 'rate_limited', message: 'limite de requêtes' } };
    if (!res.ok) return { ok: false, error: { kind: 'transport', message: `HTTP ${res.status}` } };

    let data: ChatCompletion;
    try {
      data = (await res.json()) as ChatCompletion;
    } catch {
      return { ok: false, error: { kind: 'invalid_output', message: 'réponse illisible' } };
    }
    const tokens = {
      input: data.usage?.prompt_tokens ?? 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: data.usage?.completion_tokens ?? 0,
    };
    const priced = costUsd(data.model ?? model, tokens);
    const usage = {
      provider: this.id,
      model: data.model ?? model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      costUsd: priced.cost,
      costEstimated: priced.estimated,
      latencyMs: Date.now() - started,
    };
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      return { ok: false, error: { kind: 'refusal', message: choice.message.refusal.slice(0, 200) }, usage };
    }
    if (choice?.finish_reason === 'length') {
      return { ok: false, error: { kind: 'invalid_output', message: 'réponse tronquée (limite de tokens)' }, usage };
    }
    const raw = choice?.message?.content ?? '';
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: { kind: 'invalid_output', message: 'JSON invalide' }, usage, raw };
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, error: { kind: 'invalid_output', message: 'sortie non conforme au schéma' }, usage, raw };
    }
    return { ok: true, value: parsed.data, usage, raw };
  }
}
