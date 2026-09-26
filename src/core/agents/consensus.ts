import type { AgentId, AgentReport, Consensus, Stance } from '../domain/analysis';
import { round } from '../quant/features';

const ALL_AGENTS: readonly AgentId[] = ['technical', 'fundamental', 'sentiment', 'macro'];

/**
 * Confidence-weighted vote among the reports that actually ran. Unavailable
 * and failed agents are listed as missing — they do not count as neutral.
 */
export function buildConsensus(reports: readonly AgentReport[]): Consensus {
  const weights: Record<Stance, number> = { bullish: 0, bearish: 0, neutral: 0 };
  const available: AgentId[] = [];
  for (const r of reports) {
    if (r.status !== 'ok' || r.stance === null) continue;
    available.push(r.agent);
    weights[r.stance] += r.confidence ?? 0.5;
  }
  const missing = ALL_AGENTS.filter((a) => !available.includes(a));
  const total = weights.bullish + weights.bearish + weights.neutral;
  if (total === 0) {
    return { bullish: 0, bearish: 0, neutral: 0, dominant: null, agreement: 0, available, missing };
  }
  const share = (s: Stance) => round(weights[s] / total, 4);
  const entries = (['bullish', 'bearish', 'neutral'] as const).map((s) => [s, weights[s]] as const);
  const [dominant, dominantWeight] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  return {
    bullish: share('bullish'),
    bearish: share('bearish'),
    neutral: share('neutral'),
    dominant,
    agreement: round(dominantWeight / total, 4),
    available,
    missing,
  };
}

export function unavailableReport(agent: AgentId, reason: string): AgentReport {
  return {
    agent,
    status: 'unavailable',
    stance: null,
    confidence: null,
    summary: reason,
    details: {},
    source: 'none',
    unavailableReason: reason,
  };
}
