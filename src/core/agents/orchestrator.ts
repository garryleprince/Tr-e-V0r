import type { AgentReport, Consensus, TradeProposal } from '../domain/analysis';
import { buildConsensus } from './consensus';
import type { AnalysisContext, AnalystAgent, TraderAgent, TraderOutcome } from './contracts';
import { checkProposal } from './sanity';

/**
 * The multi-agent pipeline, as a plain typed function.
 *
 *   analysts (in parallel) → consensus → trader → sanity checks
 *
 * It stops at a validated proposal. Sizing, risk and execution happen
 * elsewhere, in code the agents cannot reach. A failing analyst never fails the
 * run: its report says `error` and the others carry on.
 */

export interface PipelineResult {
  readonly reports: readonly AgentReport[];
  readonly consensus: Consensus;
  readonly trader: TraderOutcome;
  /** Present only when the trader produced a proposal that passed the sanity checks. */
  readonly proposal: TradeProposal | null;
  /** Why no usable proposal came out, when `proposal` is null. */
  readonly invalidReasons: readonly string[];
}

export async function runAgentPipeline(
  ctx: AnalysisContext,
  analysts: readonly AnalystAgent[],
  trader: TraderAgent,
): Promise<PipelineResult> {
  const settled = await Promise.allSettled(analysts.map((a) => a.analyze(ctx)));
  const reports: AgentReport[] = settled.map((result, i) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          agent: analysts[i]!.id,
          status: 'error',
          stance: null,
          confidence: null,
          summary: 'L’agent a échoué.',
          details: {},
          source: 'none',
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
  );

  const consensus = buildConsensus(reports);

  let outcome: TraderOutcome;
  try {
    outcome = await trader.propose({ ctx, reports, consensus });
  } catch (err) {
    outcome = {
      ok: false,
      source: trader.source,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!outcome.ok) {
    return { reports, consensus, trader: outcome, proposal: null, invalidReasons: [outcome.error] };
  }

  const check = checkProposal(outcome.proposal, ctx.snapshot, ctx.position !== null);
  if (!check.ok) {
    return { reports, consensus, trader: outcome, proposal: null, invalidReasons: check.reasons };
  }
  return { reports, consensus, trader: outcome, proposal: outcome.proposal, invalidReasons: [] };
}
