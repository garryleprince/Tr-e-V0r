import { TradeProposalWireSchema } from '../../src/core/domain/analysis';
import { AnthropicProvider } from '../../src/server/llm/anthropic';
import { BudgetedLlm, buildLlmProvider } from '../../src/server/llm/gateway';
import { OpenAICompatibleProvider } from '../../src/server/llm/openai-compatible';
import { costUsd } from '../../src/server/llm/pricing';
import type { LlmProvider, StructuredResult } from '../../src/server/llm/types';
import { DEFAULT_SETTINGS } from '../../src/core/domain/settings';
import { DEV_CONFIG } from '../helpers/server';

/**
 * These tests exercise the adapters against recorded-shape HTTP responses.
 * No real model is called (no API key in the development environment); what is
 * verified is our request shape and our handling of every response kind.
 */

const proposal = {
  action: 'HOLD',
  confidence: 0.6,
  entryPrice: null,
  stopLoss: null,
  takeProfit: null,
  horizonBars: null,
  sizePctOfEquity: null,
  mainScenario: { title: 'Range', description: 'Le prix reste dans sa zone.', probability: 0.6 },
  altScenario: { title: 'Cassure', description: 'Sortie de zone.', probability: 0.3 },
  keyFactors: [{ factor: 'RSI neutre', direction: 'neutral', weight: 0.5 }],
  invalidation: 'Clôture hors de la zone.',
  rationale: 'Signaux contradictoires.',
};

function anthropicMessage(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...extra,
  };
}

function recordingFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const baseOptions = {
  apiKey: 'sk-test',
  models: { deep: 'claude-opus-5', quick: 'claude-opus-5' },
  efforts: { deep: 'high', quick: 'low' },
} as const;

describe('adaptateur Claude (SDK Anthropic)', () => {
  it('envoie une requête structurée : réflexion adaptative, effort, schéma, repli serveur, cache du prompt système', async () => {
    const f = recordingFetch(anthropicMessage([{ type: 'text', text: JSON.stringify(proposal) }]));
    const llm = new AnthropicProvider({ ...baseOptions, fetch: f.fn });
    const res = await llm.generateStructured({
      tier: 'deep',
      system: 'système',
      user: '{"x":1}',
      schema: TradeProposalWireSchema,
      schemaName: 'trade_proposal',
      maxOutputTokens: 4000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.action).toBe('HOLD');
      expect(res.usage.costUsd).toBeCloseTo((1000 * 5 + 500 * 25) / 1e6, 10);
    }
    const call = f.calls[0]!;
    expect(call.url).toContain('/v1/messages');
    expect(call.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(call.body.model).toBe('claude-opus-5');
    expect(call.body.fallbacks).toBe('default');
    expect(call.body.thinking).toEqual({ type: 'adaptive' });
    expect((call.body.output_config as { effort: string }).effort).toBe('high');
    expect((call.body.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect((call.body.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('un refus n’est jamais lu comme une décision', async () => {
    const f = recordingFetch(
      anthropicMessage([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }),
    );
    const res = await new AnthropicProvider({ ...baseOptions, fetch: f.fn }).generateStructured({
      tier: 'quick',
      system: 's',
      user: 'u',
      schema: TradeProposalWireSchema,
      schemaName: 'p',
      maxOutputTokens: 100,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('refusal');
  });

  it('JSON non conforme → invalid_output ; clé refusée → not_configured', async () => {
    const bad = recordingFetch(anthropicMessage([{ type: 'text', text: '{"action":"MAYBE"}' }]));
    const r1 = await new AnthropicProvider({ ...baseOptions, fetch: bad.fn }).generateStructured({
      tier: 'quick', system: 's', user: 'u', schema: TradeProposalWireSchema, schemaName: 'p', maxOutputTokens: 100,
    });
    expect(r1.ok).toBe(false);
    const denied = recordingFetch({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    const r2 = await new AnthropicProvider({ ...baseOptions, fetch: denied.fn }).generateStructured({
      tier: 'quick', system: 's', user: 'u', schema: TradeProposalWireSchema, schemaName: 'p', maxOutputTokens: 100,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('not_configured');
  });
});

describe('adaptateur OpenAI-compatible (GPT, Gemini, modèles locaux)', () => {
  it('json_schema strict, réponse validée par le schéma', async () => {
    const f = recordingFetch({
      model: 'gpt-test',
      choices: [{ message: { content: JSON.stringify(proposal) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const llm = new OpenAICompatibleProvider({ baseUrl: 'https://example.test/v1/', apiKey: 'k', models: { deep: 'gpt-test', quick: 'gpt-test' }, efforts: { deep: 'high', quick: 'low' }, fetch: f.fn });
    const res = await llm.generateStructured({ tier: 'deep', system: 's', user: 'u', schema: TradeProposalWireSchema, schemaName: 'trade_proposal', maxOutputTokens: 100 });
    expect(res.ok).toBe(true);
    expect(f.calls[0]!.url).toBe('https://example.test/v1/chat/completions');
    const rf = f.calls[0]!.body.response_format as { type: string; json_schema: { strict: boolean } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
    expect(f.calls[0]!.headers.get('Authorization')).toBe('Bearer k');
    if (res.ok) expect(res.usage.costEstimated).toBe(true); // unknown model → priced high
  });

  it('refus et réponse non conforme', async () => {
    const refused = recordingFetch({ choices: [{ message: { content: null, refusal: 'non' } }] });
    const llm = (f: typeof fetch) =>
      new OpenAICompatibleProvider({ baseUrl: 'https://x/v1', apiKey: null, models: { deep: 'm', quick: 'm' }, efforts: { deep: 'high', quick: 'low' }, fetch: f });
    const r = await llm(refused.fn).generateStructured({ tier: 'deep', system: 's', user: 'u', schema: TradeProposalWireSchema, schemaName: 'p', maxOutputTokens: 1 });
    expect(r.ok === false && r.error.kind).toBe('refusal');
    const garbage = recordingFetch({ choices: [{ message: { content: 'pas du json' } }] });
    const g = await llm(garbage.fn).generateStructured({ tier: 'deep', system: 's', user: 'u', schema: TradeProposalWireSchema, schemaName: 'p', maxOutputTokens: 1 });
    expect(g.ok === false && g.error.kind).toBe('invalid_output');
  });
});

describe('passerelle : budget et configuration', () => {
  it('refuse l’appel une fois le budget du jour atteint, sans appeler le fournisseur', async () => {
    let calls = 0;
    const inner: LlmProvider = {
      id: 'x',
      model: () => 'claude-opus-5',
      generateStructured: async <T,>(): Promise<StructuredResult<T>> => {
        calls++;
        return { ok: true, value: proposal as T, raw: '', usage: { provider: 'x', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 1.5, costEstimated: false, latencyMs: 1 } };
      },
    };
    const budgeted = new BudgetedLlm(inner, 2, 0);
    const req = { tier: 'deep' as const, system: '', user: '', schema: TradeProposalWireSchema, schemaName: 'p', maxOutputTokens: 1 };
    expect((await budgeted.generateStructured(req)).ok).toBe(true);
    expect((await budgeted.generateStructured(req)).ok).toBe(true); // 1.5 < 2 before the call
    const third = await budgeted.generateStructured(req);
    expect(third.ok === false && third.error.kind).toBe('budget_exceeded');
    expect(calls).toBe(2);

    // Explicit "no limit" (owner's choice): never refused by the app.
    const unlimited = new BudgetedLlm(inner, null, 1_000);
    expect((await unlimited.generateStructured(req)).ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('sans clé, le fournisseur est déclaré indisponible (pas d’erreur)', () => {
    const a = buildLlmProvider(DEFAULT_SETTINGS.llm, DEV_CONFIG);
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toMatch(/ANTHROPIC_API_KEY/);
    const b = buildLlmProvider(DEFAULT_SETTINGS.llm, { ...DEV_CONFIG, keys: { ...DEV_CONFIG.keys, anthropic: 'sk' } });
    expect(b.available).toBe(true);
  });

  it('tarification : cache en lecture à 10 %, modèle inconnu estimé au tarif le plus élevé', () => {
    expect(costUsd('claude-opus-5', { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 0 }).cost).toBeCloseTo(0.5, 10);
    expect(costUsd('mystery', { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 })).toEqual({ cost: 10, estimated: true });
  });
});
