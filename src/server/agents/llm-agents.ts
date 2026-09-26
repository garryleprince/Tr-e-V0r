import type { AnalysisContext, AnalystAgent, TraderAgent, TraderInput, TraderOutcome } from '../../core/agents/contracts';
import {
  TECHNICAL_SYSTEM_PROMPT,
  TRADER_SYSTEM_PROMPT,
  technicalUserMessage,
  traderUserMessage,
} from '../../core/agents/prompts';
import { RuleBasedTechnicalAnalyst, RuleBasedTrader } from '../../core/agents/rules';
import { unavailableReport } from '../../core/agents/consensus';
import {
  TechnicalReportSchema,
  TechnicalReportWireSchema,
  TradeProposalSchema,
  TradeProposalWireSchema,
  type AgentReport,
  type LlmCallInfo,
} from '../../core/domain/analysis';
import type { LlmProvider, LlmUsage, StructuredResult } from '../llm/types';
import { LLM_ERROR_LABELS } from '../llm/types';

/**
 * LLM-backed agents. They implement the same contracts as the rule-based ones,
 * receive only the snapshot and reports, and return validated data.
 */

function callInfo(u: LlmUsage | undefined): LlmCallInfo | undefined {
  return u
    ? {
        provider: u.provider,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        costUsd: u.costUsd,
        latencyMs: u.latencyMs,
      }
    : undefined;
}

function failure(r: Extract<StructuredResult<unknown>, { ok: false }>): string {
  return `${LLM_ERROR_LABELS[r.error.kind]} — ${r.error.message}`;
}

export class LlmTechnicalAnalyst implements AnalystAgent {
  readonly id = 'technical' as const;
  constructor(private readonly llm: LlmProvider) {}

  async analyze(ctx: AnalysisContext): Promise<AgentReport> {
    const user = technicalUserMessage(ctx);
    const res = await this.llm.generateStructured({
      tier: 'quick',
      system: TECHNICAL_SYSTEM_PROMPT,
      user,
      schema: TechnicalReportWireSchema,
      schemaName: 'technical_report',
      maxOutputTokens: 8_000,
    });
    const transcript = { system: TECHNICAL_SYSTEM_PROMPT, user, raw: res.raw ?? '' };
    if (!res.ok) {
      return {
        agent: 'technical',
        status: 'error',
        stance: null,
        confidence: null,
        summary: 'L’analyse IA a échoué.',
        details: {},
        source: 'llm',
        llm: callInfo(res.usage),
        transcript,
        error: failure(res),
      };
    }
    const strict = TechnicalReportSchema.safeParse(res.value);
    if (!strict.success) {
      return {
        agent: 'technical',
        status: 'error',
        stance: null,
        confidence: null,
        summary: 'Réponse IA hors bornes.',
        details: { issues: strict.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
        source: 'llm',
        llm: callInfo(res.usage),
        transcript,
        error: 'sortie hors des bornes du schéma',
      };
    }
    // Levels quoted by the model must exist near the market: drop anything
    // further than 50 % from the last close as a hallucination, and say so.
    const ref = ctx.snapshot.lastClose;
    const kept = strict.data.keyLevels.filter((l) => Math.abs(l.price / ref - 1) <= 0.5);
    const droppedLevels = strict.data.keyLevels.length - kept.length;
    return {
      agent: 'technical',
      status: 'ok',
      stance: strict.data.stance,
      confidence: strict.data.confidence,
      summary: strict.data.summary,
      details: {
        keyLevels: kept,
        signals: strict.data.signals,
        risks: strict.data.risks,
        ...(droppedLevels > 0 ? { droppedLevels } : {}),
      },
      source: 'llm',
      llm: callInfo(res.usage),
      transcript,
    };
  }
}

export class LlmTrader implements TraderAgent {
  readonly source = 'llm' as const;
  constructor(private readonly llm: LlmProvider) {}

  async propose({ ctx, reports, consensus }: TraderInput): Promise<TraderOutcome> {
    const user = traderUserMessage(ctx, reports, consensus);
    const res = await this.llm.generateStructured({
      tier: 'deep',
      system: TRADER_SYSTEM_PROMPT,
      user,
      schema: TradeProposalWireSchema,
      schemaName: 'trade_proposal',
      maxOutputTokens: 16_000,
    });
    const transcript = { system: TRADER_SYSTEM_PROMPT, user, raw: res.raw ?? '' };
    if (!res.ok) return { ok: false, source: 'llm', error: failure(res), llm: callInfo(res.usage), transcript };
    const strict = TradeProposalSchema.safeParse(res.value);
    if (!strict.success) {
      return {
        ok: false,
        source: 'llm',
        error: `proposition hors bornes : ${strict.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join(' ; ')}`,
        llm: callInfo(res.usage),
        transcript,
      };
    }
    return { ok: true, source: 'llm', proposal: strict.data, llm: callInfo(res.usage), transcript };
  }
}

/**
 * Wraps an LLM trader so that a failure falls back to the rule-based trader —
 * only when the user explicitly enabled `fallbackToRules`. The switch of source
 * is visible in the journal (source = 'rules', with the LLM error recorded).
 */
export class FallbackTrader implements TraderAgent {
  readonly source = 'llm' as const;
  constructor(
    private readonly primary: TraderAgent,
    private readonly fallback: TraderAgent = new RuleBasedTrader(),
  ) {}

  async propose(input: TraderInput): Promise<TraderOutcome> {
    const first = await this.primary.propose(input);
    if (first.ok) return first;
    const second = await this.fallback.propose(input);
    return second.ok
      ? { ...second, llm: first.llm, transcript: first.transcript }
      : { ...second, error: `${first.error} ; repli : ${second.error}` };
  }
}

export interface AgentLineup {
  readonly analysts: AnalystAgent[];
  readonly trader: TraderAgent;
  /** 'llm' when an LLM drives the decision, 'rules' otherwise. */
  readonly engine: 'llm' | 'rules';
  readonly note: string | null;
}

/**
 * Which agents run. Without a usable LLM the deterministic agents run and the
 * journal says so — that is a configuration state, not a failure.
 */
export function buildLineup(llm: LlmProvider | null, unavailableReason: string | null, fallbackToRules: boolean): AgentLineup {
  const others: AnalystAgent[] = [
    staticUnavailable('fundamental', 'Aucun fournisseur de données fondamentales connecté (prévu en V0.2).'),
    staticUnavailable('sentiment', 'Aucun flux d’actualités ou de sentiment connecté (prévu en V0.2).'),
    staticUnavailable('macro', 'Aucune source macroéconomique connectée (prévu en V0.2).'),
  ];
  if (!llm) {
    return {
      analysts: [new RuleBasedTechnicalAnalyst(), ...others],
      trader: new RuleBasedTrader(),
      engine: 'rules',
      note: `Analyse quantitative sans IA : ${unavailableReason ?? 'IA indisponible'}.`,
    };
  }
  const trader = fallbackToRules ? new FallbackTrader(new LlmTrader(llm)) : new LlmTrader(llm);
  return { analysts: [new LlmTechnicalAnalyst(llm), ...others], trader, engine: 'llm', note: null };
}

function staticUnavailable(id: 'fundamental' | 'sentiment' | 'macro', reason: string): AnalystAgent {
  return { id, analyze: async () => unavailableReport(id, reason) };
}
