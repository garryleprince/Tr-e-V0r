import type { AnalysisContext, PortfolioView } from '../../core/agents/contracts';
import { runAgentPipeline } from '../../core/agents/orchestrator';
import type { AgentReport, DecisionStatus } from '../../core/domain/analysis';
import type { Instrument } from '../../core/domain/market';
import { utcDayStart } from '../../core/domain/time';
import { logReturns, pearson } from '../../core/quant/indicators';
import { computeSnapshot, MIN_BARS_FOR_SNAPSHOT } from '../../core/quant/features';
import { planOrder } from '../../core/portfolio/manager';
import { buildLineup } from '../agents/llm-agents';
import { CandleService } from '../data/candle-service';
import { addEvent, getCandles, getInstrument, getSettings } from '../db/core';
import {
  decisionStatement,
  finishRunStatement,
  llmSpendSince,
  reportStatement,
  startRun,
  updateDecisionStatus,
} from '../db/runs';
import { getAccount, openPositions } from '../db/trading';
import type { DeskView, SubmitRequest, SubmitResult } from '../desk/desk-core';
import type { RuntimeConfig } from '../env';
import { BudgetedLlm, buildLlmProvider } from '../llm/gateway';
import { errorMessage, log, newId } from '../util';

/**
 * The analysis cycle for one instrument:
 * data engine → snapshot → agents → decision → Portfolio Manager → desk (risk,
 * execution) → journal. Everything that happened is written down, including
 * failures, refusals and "nothing to do".
 */

export interface DeskClient {
  view(): Promise<DeskView>;
  submit(req: SubmitRequest): Promise<SubmitResult>;
}

export interface AnalysisDeps {
  readonly db: D1Database;
  readonly config: RuntimeConfig;
  readonly candles: CandleService;
  readonly desk: DeskClient;
  readonly now: () => number;
  /** Injected in tests to fake the LLM provider's HTTP. */
  readonly llmFetch?: typeof fetch;
}

export interface AnalysisOutcome {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'skipped';
  readonly decisionId: string | null;
  readonly decisionStatus: DecisionStatus | null;
  readonly note: string;
}

const HISTORY_BARS = 300;

export async function runAnalysis(
  deps: AnalysisDeps,
  instrumentId: string,
  trigger: 'schedule' | 'manual',
): Promise<AnalysisOutcome> {
  const { db, now } = deps;
  const settings = await getSettings(db);
  const tf = settings.watchlist.timeframe;
  const instrument = await getInstrument(db, instrumentId);
  if (!instrument || !instrument.active) throw new Error(`instrument inconnu ou inactif : ${instrumentId}`);
  const desk = await deps.desk.view();

  const runId = newId();
  await startRun(db, { id: runId, instrumentId, timeframe: tf, trigger, mode: desk.mode, tradingState: desk.effectiveState, startedAt: now() });

  // Condor: when the risk layer blocks everything, the scheduled cycle does not
  // even call the model — cheaper and safer.
  if (trigger === 'schedule' && desk.effectiveState === 'HALTED') {
    await finishRunStatement(db, runId, {
      status: 'skipped',
      finishedAt: now(),
      asOf: null,
      dataSource: null,
      snapshot: null,
      consensus: null,
      error: 'Kill switch actif : cycle planifié ignoré',
      llmCostUsd: 0,
    }).run();
    return { runId, status: 'skipped', decisionId: null, decisionStatus: null, note: 'Kill switch actif' };
  }

  try {
    const data = await deps.candles.getClosedCandles(instrument, tf, HISTORY_BARS);
    if (data.candles.length < MIN_BARS_FOR_SNAPSHOT) {
      throw new Error(
        `historique insuffisant pour ${instrument.displayName} : ${data.candles.length} bougies (${data.warnings.join(' ; ') || 'aucune donnée'})`,
      );
    }
    const snapshot = computeSnapshot(instrument.id, tf, data.candles);
    const quote = instrument.assetClass === 'crypto' ? await deps.candles.getQuote(instrument) : null;
    const quoteFresh = quote !== null && now() - quote.ts < 5 * 60_000;

    const positions = await openPositions(db, 'PAPER');
    const account = await getAccount(db, 'PAPER');
    const marks = await lastCloses(db, positions.map((p) => p.instrumentId), tf);
    const exposure = positions.reduce((a, p) => a + p.quantity * (marks[p.instrumentId] ?? p.avgPrice), 0);
    const cash = account?.cash ?? 0;
    const portfolio: PortfolioView = {
      equity: cash + exposure,
      cash,
      grossExposure: exposure,
      openPositions: positions.map((p) => ({ instrumentId: p.instrumentId, quantity: p.quantity, avgPrice: p.avgPrice })),
    };
    const position = positions.find((p) => p.instrumentId === instrument.id) ?? null;
    const ctx: AnalysisContext = { instrument, timeframe: tf, asOf: snapshot.asOf, candles: data.candles, snapshot, position, portfolio };

    const availability = buildLlmProvider(settings.llm, deps.config, deps.llmFetch);
    const budgeted = availability.available
      ? new BudgetedLlm(availability.provider, settings.llm.dailyBudgetUsd, await llmSpendSince(db, utcDayStart(now())))
      : null;
    const lineup = buildLineup(budgeted, availability.available ? null : availability.reason, settings.llm.fallbackToRules);
    const result = await runAgentPipeline(ctx, lineup.analysts, lineup.trader);

    const created = now();
    const decisionId = newId();
    const traderReport: Pick<AgentReport, 'status' | 'stance' | 'confidence' | 'summary' | 'details' | 'source' | 'llm' | 'transcript' | 'error'> = {
      status: result.trader.ok ? 'ok' : 'error',
      stance: null,
      confidence: result.trader.ok ? result.trader.proposal.confidence : null,
      summary: result.trader.ok ? result.trader.proposal.rationale : 'Le trader n’a pas produit de proposition.',
      details: lineup.note ? { note: lineup.note } : {},
      source: result.trader.source,
      llm: result.trader.llm,
      transcript: result.trader.transcript,
      error: result.trader.ok ? undefined : result.trader.error,
    };

    const referencePrice = quoteFresh ? quote!.last : snapshot.lastClose;
    let status: DecisionStatus = result.proposal ? 'PROPOSED' : 'INVALID';
    let planExplanation: string | null = null;
    let plan: ReturnType<typeof planOrder> | null = null;
    if (result.proposal) {
      plan = planOrder({
        proposal: result.proposal,
        instrument,
        timeframe: tf,
        referencePrice,
        asOf: snapshot.asOf,
        position,
        equity: portfolio.equity,
        riskPct: settings.risk.maxRiskPerTradePct,
        decisionId,
      });
      planExplanation = plan.explanation;
      if (plan.kind === 'none') status = 'NOT_EXECUTED';
    }

    await db.batch([
      ...result.reports.map((r) => reportStatement(db, runId, r.agent, r, created)),
      reportStatement(db, runId, 'trader', traderReport, created),
      decisionStatement(db, {
        id: decisionId,
        runId,
        instrumentId: instrument.id,
        mode: desk.mode,
        status,
        source: result.trader.source,
        proposal: result.trader.ok ? result.trader.proposal : null,
        referencePrice,
        asOf: snapshot.asOf,
        invalidReasons: result.invalidReasons,
        planExplanation,
        createdAt: created,
      }),
    ]);

    let note = planExplanation ?? result.invalidReasons.join(' ; ');
    if (plan?.kind === 'order') {
      const submitted = await deps.desk.submit({
        intent: plan.intent,
        market: {
          referencePrice,
          dataAsOf: snapshot.asOf,
          maxDataAgeMs: CandleService.maxDataAgeMs(instrument, tf, settings.risk.maxDataAgeBars),
          atr: snapshot.atr14,
          avgDollarVolume: snapshot.avgDollarVolume20,
          bid: quoteFresh ? quote!.bid : null,
          ask: quoteFresh ? quote!.ask : null,
        },
        correlations: await correlations(db, instrument, positions.map((p) => p.instrumentId), tf),
      });
      status = submitted.executed
        ? 'EXECUTED'
        : submitted.verdict.outcome === 'REJECTED'
          ? 'REJECTED'
          : 'NOT_EXECUTED';
      note = submitted.note;
      await updateDecisionStatus(db, decisionId, status, submitted.note);
    }

    if (status === 'INVALID') {
      await addEvent(db, {
        ts: now(),
        type: 'decision_invalid',
        severity: 'warning',
        actor: 'agent',
        title: `Décision invalide — ${instrument.displayName}`,
        data: { runId, reasons: result.invalidReasons },
      });
    }
    await finishRunStatement(db, runId, {
      status: 'completed',
      finishedAt: now(),
      asOf: snapshot.asOf,
      dataSource: data.source,
      snapshot,
      consensus: result.consensus,
      error: data.warnings.length > 0 ? data.warnings.join(' ; ') : null,
      llmCostUsd: budgeted?.runSpendUsd ?? 0,
    }).run();
    return { runId, status: 'completed', decisionId, decisionStatus: status, note };
  } catch (err) {
    const message = errorMessage(err);
    log('error', 'analysis failed', { runId, instrumentId, error: message });
    await finishRunStatement(db, runId, {
      status: 'failed',
      finishedAt: now(),
      asOf: null,
      dataSource: null,
      snapshot: null,
      consensus: null,
      error: message,
      llmCostUsd: 0,
    }).run();
    await addEvent(db, {
      ts: now(),
      type: 'analysis_failed',
      severity: 'warning',
      actor: 'system',
      title: `Analyse impossible — ${instrument.displayName}`,
      data: { runId, error: message },
    });
    return { runId, status: 'failed', decisionId: null, decisionStatus: null, note: message };
  }
}

/** Runs the whole watchlist, one instrument after the other. */
export async function runWatchlistCycle(deps: AnalysisDeps, trigger: 'schedule' | 'manual'): Promise<AnalysisOutcome[]> {
  const settings = await getSettings(deps.db);
  const out: AnalysisOutcome[] = [];
  for (const id of settings.watchlist.instrumentIds) {
    try {
      out.push(await runAnalysis(deps, id, trigger));
    } catch (err) {
      log('error', 'watchlist item failed', { instrumentId: id, error: errorMessage(err) });
    }
  }
  return out;
}

async function lastCloses(db: D1Database, ids: readonly string[], tf: AnalysisContext['timeframe']): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of new Set(ids)) {
    const { candles } = await getCandles(db, id, tf, 1);
    if (candles[0]) out[id] = candles[0].c;
  }
  return out;
}

/** Correlation of daily log returns over the last 60 common bars. NaN when too little overlap. */
async function correlations(
  db: D1Database,
  instrument: Instrument,
  heldIds: readonly string[],
  tf: AnalysisContext['timeframe'],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const { candles: mine } = await getCandles(db, instrument.id, tf, 61);
  const mineByT = new Map(mine.map((k) => [k.t, k.c]));
  for (const id of new Set(heldIds)) {
    if (id === instrument.id) continue;
    const { candles: theirs } = await getCandles(db, id, tf, 61);
    const common = theirs.filter((k) => mineByT.has(k.t));
    if (common.length < 30) {
      out[id] = Number.NaN;
      continue;
    }
    const a = logReturns(common.map((k) => mineByT.get(k.t)!)).slice(1);
    const b = logReturns(common.map((k) => k.c)).slice(1);
    out[id] = pearson(a, b);
  }
  return out;
}
