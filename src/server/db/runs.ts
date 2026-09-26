import type { AgentReport, Consensus, DecisionStatus, TradeProposal } from '../../core/domain/analysis';
import type { Timeframe } from '../../core/domain/time';
import type { Mode, TradingState } from '../../core/domain/trading';
import type { TechnicalSnapshot } from '../../core/quant/features';
import { newId, parseJson } from '../util';

/**
 * The decision journal: analysis runs, agent reports and decisions — everything
 * needed later to answer "why was the agent wrong?".
 */

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export interface RunStart {
  readonly id: string;
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  readonly trigger: 'schedule' | 'manual';
  readonly mode: Mode;
  readonly tradingState: TradingState;
  readonly startedAt: number;
}

export async function startRun(db: D1Database, r: RunStart): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analysis_runs (id, instrument_id, timeframe, trigger, mode, trading_state, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .bind(r.id, r.instrumentId, r.timeframe, r.trigger, r.mode, r.tradingState, r.startedAt)
    .run();
}

export function finishRunStatement(
  db: D1Database,
  id: string,
  f: {
    status: 'completed' | 'failed' | 'skipped';
    finishedAt: number;
    asOf: number | null;
    dataSource: string | null;
    snapshot: TechnicalSnapshot | null;
    consensus: Consensus | null;
    error: string | null;
    llmCostUsd: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE analysis_runs SET status = ?, finished_at = ?, as_of = ?, data_source = ?, snapshot = ?, consensus = ?, error = ?, llm_cost_usd = ?
       WHERE id = ?`,
    )
    .bind(
      f.status,
      f.finishedAt,
      f.asOf,
      f.dataSource,
      f.snapshot ? JSON.stringify(f.snapshot) : null,
      f.consensus ? JSON.stringify(f.consensus) : null,
      f.error,
      f.llmCostUsd,
      id,
    );
}

export function reportStatement(
  db: D1Database,
  runId: string,
  agent: string,
  r: Pick<AgentReport, 'status' | 'stance' | 'confidence' | 'summary' | 'details' | 'source' | 'llm' | 'transcript' | 'error'>,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_reports (id, run_id, agent, status, stance, confidence, summary, details, source, provider, model,
         input_tokens, output_tokens, cost_usd, latency_ms, transcript, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      runId,
      agent,
      r.status,
      r.stance,
      r.confidence,
      r.summary,
      JSON.stringify(r.details ?? {}),
      r.source,
      r.llm?.provider ?? null,
      r.llm?.model ?? null,
      r.llm?.inputTokens ?? null,
      r.llm?.outputTokens ?? null,
      r.llm?.costUsd ?? null,
      r.llm?.latencyMs ?? null,
      r.transcript ? JSON.stringify(r.transcript) : null,
      r.error ?? null,
      now,
    );
}

export interface DecisionInsert {
  readonly id: string;
  readonly runId: string;
  readonly instrumentId: string;
  readonly mode: Mode;
  readonly status: DecisionStatus;
  readonly source: 'llm' | 'rules';
  readonly proposal: TradeProposal | null;
  readonly referencePrice: number;
  readonly asOf: number;
  readonly invalidReasons: readonly string[];
  readonly planExplanation: string | null;
  readonly createdAt: number;
}

export function decisionStatement(db: D1Database, d: DecisionInsert): D1PreparedStatement {
  const p = d.proposal;
  return db
    .prepare(
      `INSERT INTO decisions (id, run_id, instrument_id, mode, action, status, source, confidence, entry_price, stop_loss, take_profit,
         horizon_bars, size_pct, reference_price, as_of, proposal, invalid_reasons, plan_explanation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      d.id,
      d.runId,
      d.instrumentId,
      d.mode,
      p?.action ?? null,
      d.status,
      d.source,
      p?.confidence ?? null,
      p?.entryPrice ?? null,
      p?.stopLoss ?? null,
      p?.takeProfit ?? null,
      p?.horizonBars ?? null,
      p?.sizePctOfEquity ?? null,
      d.referencePrice,
      d.asOf,
      p ? JSON.stringify(p) : null,
      d.invalidReasons.length > 0 ? JSON.stringify(d.invalidReasons) : null,
      d.planExplanation,
      d.createdAt,
    );
}

export async function updateDecisionStatus(
  db: D1Database,
  id: string,
  status: DecisionStatus,
  executionNote: string | null,
): Promise<void> {
  await db.prepare('UPDATE decisions SET status = ?, execution_note = ? WHERE id = ?').bind(status, executionNote, id).run();
}

// --------------------------------------------------------------------- reads

export interface RunSummary {
  readonly id: string;
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly trigger: string;
  readonly mode: string;
  readonly status: string;
  readonly asOf: number | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error: string | null;
  readonly llmCostUsd: number;
  readonly decision: DecisionSummary | null;
}

export interface DecisionSummary {
  readonly id: string;
  readonly runId: string;
  readonly instrumentId: string;
  readonly mode: string;
  readonly action: string | null;
  readonly status: DecisionStatus;
  readonly source: string;
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

export interface VerdictSummary {
  readonly id: string;
  readonly outcome: string;
  readonly requestedQty: number;
  readonly approvedQty: number;
  readonly checks: unknown[];
  readonly limits: unknown;
  readonly tradingState: string;
  readonly summary: string;
}

function mapDecision(r: Row, verdict: VerdictSummary | null): DecisionSummary {
  return {
    id: str(r.id),
    runId: str(r.run_id),
    instrumentId: str(r.instrument_id),
    mode: str(r.mode),
    action: strOrNull(r.action),
    status: str(r.status) as DecisionStatus,
    source: str(r.source),
    confidence: numOrNull(r.confidence),
    entryPrice: numOrNull(r.entry_price),
    stopLoss: numOrNull(r.stop_loss),
    takeProfit: numOrNull(r.take_profit),
    horizonBars: numOrNull(r.horizon_bars),
    referencePrice: num(r.reference_price),
    asOf: num(r.as_of),
    createdAt: num(r.created_at),
    proposal: parseJson<TradeProposal | null>(strOrNull(r.proposal), null),
    invalidReasons: parseJson<string[]>(strOrNull(r.invalid_reasons), []),
    planExplanation: strOrNull(r.plan_explanation),
    executionNote: strOrNull(r.execution_note),
    verdict,
  };
}

function mapVerdict(r: Row): VerdictSummary {
  return {
    id: str(r.id),
    outcome: str(r.outcome),
    requestedQty: num(r.requested_qty),
    approvedQty: num(r.approved_qty),
    checks: parseJson<unknown[]>(strOrNull(r.checks), []),
    limits: parseJson(strOrNull(r.limits_snapshot), null),
    tradingState: str(r.trading_state),
    summary: str(r.summary),
  };
}

async function verdictsFor(db: D1Database, decisionIds: string[]): Promise<Map<string, VerdictSummary>> {
  const out = new Map<string, VerdictSummary>();
  if (decisionIds.length === 0) return out;
  const { results } = await db
    .prepare(`SELECT * FROM risk_verdicts WHERE decision_id IN (${decisionIds.map(() => '?').join(',')}) ORDER BY created_at`)
    .bind(...decisionIds)
    .all<Row>();
  for (const r of results) out.set(str(r.decision_id), mapVerdict(r));
  return out;
}

export async function listDecisions(
  db: D1Database,
  opts: { limit: number; before?: number; instrumentId?: string; status?: string },
): Promise<DecisionSummary[]> {
  const where = ['created_at < ?'];
  const args: unknown[] = [opts.before ?? Number.MAX_SAFE_INTEGER];
  if (opts.instrumentId) {
    where.push('instrument_id = ?');
    args.push(opts.instrumentId);
  }
  if (opts.status) {
    where.push('status = ?');
    args.push(opts.status);
  }
  const { results } = await db
    .prepare(`SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .bind(...args, opts.limit)
    .all<Row>();
  const verdicts = await verdictsFor(db, results.map((r) => str(r.id)));
  return results.map((r) => mapDecision(r, verdicts.get(str(r.id)) ?? null));
}

export async function listRuns(db: D1Database, opts: { limit: number; before?: number; instrumentId?: string }): Promise<RunSummary[]> {
  const where = ['started_at < ?'];
  const args: unknown[] = [opts.before ?? Number.MAX_SAFE_INTEGER];
  if (opts.instrumentId) {
    where.push('instrument_id = ?');
    args.push(opts.instrumentId);
  }
  const { results } = await db
    .prepare(`SELECT * FROM analysis_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`)
    .bind(...args, opts.limit)
    .all<Row>();
  const ids = results.map((r) => str(r.id));
  const decisions = new Map<string, DecisionSummary>();
  if (ids.length > 0) {
    const { results: drows } = await db
      .prepare(`SELECT * FROM decisions WHERE run_id IN (${ids.map(() => '?').join(',')})`)
      .bind(...ids)
      .all<Row>();
    const verdicts = await verdictsFor(db, drows.map((r) => str(r.id)));
    for (const d of drows) decisions.set(str(d.run_id), mapDecision(d, verdicts.get(str(d.id)) ?? null));
  }
  return results.map((r) => mapRun(r, decisions.get(str(r.id)) ?? null));
}

function mapRun(r: Row, decision: DecisionSummary | null): RunSummary {
  return {
    id: str(r.id),
    instrumentId: str(r.instrument_id),
    timeframe: str(r.timeframe),
    trigger: str(r.trigger),
    mode: str(r.mode),
    status: str(r.status),
    asOf: numOrNull(r.as_of),
    startedAt: num(r.started_at),
    finishedAt: numOrNull(r.finished_at),
    error: strOrNull(r.error),
    llmCostUsd: num(r.llm_cost_usd),
    decision,
  };
}

export async function getRunDetail(db: D1Database, id: string) {
  const run = await db.prepare('SELECT * FROM analysis_runs WHERE id = ?').bind(id).first<Row>();
  if (!run) return null;
  const { results: reports } = await db
    .prepare('SELECT * FROM agent_reports WHERE run_id = ? ORDER BY created_at, agent')
    .bind(id)
    .all<Row>();
  const drow = await db.prepare('SELECT * FROM decisions WHERE run_id = ?').bind(id).first<Row>();
  const verdicts = drow ? await verdictsFor(db, [str(drow.id)]) : new Map<string, VerdictSummary>();
  const decision = drow ? mapDecision(drow, verdicts.get(str(drow.id)) ?? null) : null;
  const { results: orders } = await db
    .prepare(
      `SELECT o.*, f.price AS fill_price, f.fee AS fill_fee, f.slippage_bps AS fill_slippage_bps FROM orders o
       LEFT JOIN fills f ON f.order_id = o.id WHERE o.decision_id IN (SELECT id FROM decisions WHERE run_id = ?)`,
    )
    .bind(id)
    .all<Row>();
  return {
    run: mapRun(run, decision),
    snapshot: parseJson<TechnicalSnapshot | null>(strOrNull(run.snapshot), null),
    consensus: parseJson<Consensus | null>(strOrNull(run.consensus), null),
    dataSource: strOrNull(run.data_source),
    reports: reports.map((r) => ({
      agent: str(r.agent),
      status: str(r.status),
      stance: strOrNull(r.stance),
      confidence: numOrNull(r.confidence),
      summary: str(r.summary),
      details: parseJson(strOrNull(r.details), {}),
      source: str(r.source),
      provider: strOrNull(r.provider),
      model: strOrNull(r.model),
      inputTokens: numOrNull(r.input_tokens),
      outputTokens: numOrNull(r.output_tokens),
      costUsd: numOrNull(r.cost_usd),
      latencyMs: numOrNull(r.latency_ms),
      transcript: parseJson(strOrNull(r.transcript), null),
      error: strOrNull(r.error),
    })),
    orders: orders.map((o) => ({
      id: str(o.id),
      side: str(o.side),
      quantity: num(o.quantity),
      status: str(o.status),
      origin: str(o.origin),
      fillPrice: numOrNull(o.fill_price),
      fee: numOrNull(o.fill_fee),
      slippageBps: numOrNull(o.fill_slippage_bps),
      createdAt: num(o.created_at),
    })),
  };
}

/** LLM spend since `since` (ms), for the daily budget. */
export async function llmSpendSince(db: D1Database, since: number): Promise<number> {
  const r = await db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_reports WHERE created_at >= ?')
    .bind(since)
    .first<Row>();
  return r ? num(r.total) : 0;
}

export async function latestSnapshot(
  db: D1Database,
  instrumentId: string,
): Promise<{ snapshot: TechnicalSnapshot; runId: string; startedAt: number } | null> {
  const r = await db
    .prepare("SELECT id, snapshot, started_at FROM analysis_runs WHERE instrument_id = ? AND snapshot IS NOT NULL ORDER BY started_at DESC LIMIT 1")
    .bind(instrumentId)
    .first<Row>();
  if (!r) return null;
  const snapshot = parseJson<TechnicalSnapshot | null>(strOrNull(r.snapshot), null);
  return snapshot ? { snapshot, runId: str(r.id), startedAt: num(r.started_at) } : null;
}
