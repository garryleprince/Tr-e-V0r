import type { TradeProposal } from '../domain/analysis';
import type { Candle, Instrument } from '../domain/market';
import { barCloseTime, barsPerYear, TIMEFRAME_MS, utcDayStart, type Timeframe } from '../domain/time';
import type { ClosedTrade, OpenPosition, TradingState } from '../domain/trading';
import { applyBuy, applySell, positionValue } from '../portfolio/ledger';
import { planOrder } from '../portfolio/manager';
import { computeSnapshot, type TechnicalSnapshot } from '../quant/features';
import { evaluateIntent, requiredStateFromHealth, type RiskCheck } from '../risk/engine';
import type { RiskLimits } from '../risk/limits';
import { evaluateBarriers, fillMarketOrder, type CostModel } from '../sim/exchange';
import { computeMetrics, type EquityPoint, type PerformanceMetrics } from './metrics';

/**
 * Event-driven backtest, one instrument, market orders.
 *
 * Timeline for every bar `i` (all prices known only once the bar has closed):
 *   1. an order decided at the close of bar i−1 fills at the OPEN of bar i;
 *   2. the triple barrier of an open position is checked against bar i;
 *   3. equity is marked at the close of bar i;
 *   4. the strategy sees bars 0..i and may decide — the order waits for bar i+1.
 * The strategy receives a copy of the past only; it cannot reach bar i+1.
 *
 * Sizing, the Risk Engine and the fill model are the ones paper trading uses.
 */

export interface StrategyView {
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  readonly candles: readonly Candle[];
  readonly snapshot: TechnicalSnapshot;
  readonly holding: boolean;
}

export interface Strategy {
  readonly id: string;
  decide(view: StrategyView): TradeProposal | null;
}

/** Common interface so another engine (e.g. an external service) can replace this one. */
export interface BacktestEngine {
  run(config: BacktestConfig): BacktestResult;
}

export interface BacktestConfig {
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  /** All candles, oldest first, including warm-up history before `tradeFrom`. */
  readonly candles: readonly Candle[];
  /** First bar OPEN time on which a decision may be taken. */
  readonly tradeFrom: number;
  /** Bars opening at or after this time are ignored. */
  readonly tradeTo: number;
  readonly strategy: Strategy;
  readonly initialCash: number;
  readonly costs: CostModel;
  readonly limits: RiskLimits;
  /** Look-back window handed to the snapshot (bounded for speed, same as live). */
  readonly window?: number;
}

export interface BacktestResult {
  readonly trades: readonly ClosedTrade[];
  readonly equity: readonly EquityPoint[];
  readonly metrics: PerformanceMetrics;
  readonly decisions: number;
  readonly rejected: number;
  readonly rejectionsByRule: Readonly<Record<string, number>>;
  readonly haltedAt: number | null;
  readonly warnings: readonly string[];
}

const WARMUP_BARS = 50;

export function runBacktest(cfg: BacktestConfig): BacktestResult {
  const { instrument, timeframe, costs, limits } = cfg;
  const barMs = TIMEFRAME_MS[timeframe];
  const window = cfg.window ?? 300;
  const candles = cfg.candles.filter((k) => k.t < cfg.tradeTo);
  const warnings: string[] = [];

  let cash = cfg.initialCash;
  let position: OpenPosition | null = null;
  let peak = cfg.initialCash;
  let dayStart = cfg.initialCash;
  let day = -1;
  let ordersToday = 0;
  let consecutiveLosses = 0;
  let lastLossAt: number | null = null;
  let tradingState: TradingState = 'ACTIVE';
  let haltedAt: number | null = null;
  let pending: { side: 'BUY' | 'SELL'; quantity: number; stop: number | null; target: number | null; expiresAt: number | null } | null = null;
  let decisions = 0;
  let rejected = 0;
  const rejectionsByRule: Record<string, number> = {};
  const trades: ClosedTrade[] = [];
  const equity: EquityPoint[] = [];
  let seq = 0;

  const recordTrade = (t: ClosedTrade) => {
    trades.push(t);
    if (t.pnl < 0) {
      consecutiveLosses += 1;
      lastLossAt = t.closedAt;
    } else {
      consecutiveLosses = 0;
    }
  };

  const firstIndex = candles.findIndex((k) => k.t >= cfg.tradeFrom);
  if (firstIndex < 0) {
    return emptyResult(cfg.initialCash, ['aucune bougie dans la période']);
  }
  if (firstIndex < WARMUP_BARS) {
    warnings.push(`historique de chauffe court : ${firstIndex} bougies avant la période (${WARMUP_BARS} conseillées)`);
  }

  for (let i = Math.max(firstIndex, 30); i < candles.length; i++) {
    const bar = candles[i]!;
    const close = barCloseTime(bar.t, timeframe);
    const barDay = utcDayStart(bar.t);

    // 1. Execute the order decided at the previous close, at this bar's open.
    if (pending) {
      const fill = fillMarketOrder(pending.side, pending.quantity, { referencePrice: bar.o, bid: null, ask: null, ts: bar.t }, costs);
      if (pending.side === 'BUY') {
        if (fill.price * fill.quantity + fill.fee <= cash) {
          ({ cash, position } = applyBuy({ cash, position }, fill, {
            id: `bt-${seq++}`,
            instrumentId: instrument.id,
            mode: 'PAPER',
            stopLoss: pending.stop,
            takeProfit: pending.target,
            expiresAt: pending.expiresAt,
            decisionId: null,
          }));
        } else {
          warnings.push(`ordre non exécuté faute de cash à ${new Date(bar.t).toISOString()} (écart d’ouverture)`);
        }
      } else if (position) {
        const res = applySell({ cash, position }, { ...fill, quantity: Math.min(fill.quantity, position.quantity) }, 'signal');
        ({ cash, position } = res.state);
        recordTrade(res.trade);
      }
      pending = null;
    }

    // 2. Triple barrier on this bar.
    if (position) {
      const exit = evaluateBarriers(position, [bar], barMs);
      if (exit) {
        const fill = fillMarketOrder('SELL', position.quantity, { referencePrice: exit.price, bid: null, ask: null, ts: exit.ts }, costs);
        const res = applySell({ cash, position }, fill, exit.reason);
        ({ cash, position } = res.state);
        recordTrade(res.trade);
      }
    }

    // 3. Mark to market at the close.
    const value = positionValue(position, bar.c);
    const eq = cash + value;
    if (barDay !== day) {
      day = barDay;
      dayStart = equity.length > 0 ? equity[equity.length - 1]!.equity : eq;
      ordersToday = 0;
      if (tradingState === 'REDUCING') tradingState = 'ACTIVE';
    }
    peak = Math.max(peak, eq);
    equity.push({ t: close, equity: eq, exposure: eq > 0 ? value / eq : 0 });

    const health = requiredStateFromHealth(limits, eq, peak, dayStart);
    if (health.state === 'HALTED' && tradingState !== 'HALTED') {
      tradingState = 'HALTED';
      haltedAt = close;
    } else if (health.state === 'REDUCING' && tradingState === 'ACTIVE') {
      tradingState = 'REDUCING';
    }

    // 4. Decide at the close; nothing after bar i is visible.
    if (i === candles.length - 1) break;
    const past = candles.slice(Math.max(0, i + 1 - window), i + 1);
    const snapshot = computeSnapshot(instrument.id, timeframe, past);
    const proposal = cfg.strategy.decide({
      instrument,
      timeframe,
      candles: past,
      snapshot,
      holding: position !== null,
    });
    if (!proposal || proposal.action === 'HOLD') continue;
    decisions += 1;

    const plan = planOrder({
      proposal,
      instrument,
      timeframe,
      referencePrice: bar.c,
      asOf: close,
      position,
      equity: eq,
      riskPct: limits.maxRiskPerTradePct,
      decisionId: null,
    });
    if (plan.kind === 'none') continue;

    const { verdict, order } = evaluateIntent(plan.intent, {
      now: close,
      mode: 'PAPER',
      tradingState,
      limits,
      equity: eq,
      cash,
      peakEquity: peak,
      dayStartEquity: dayStart,
      positions: position ? [{ instrumentId: instrument.id, quantity: position.quantity, markPrice: bar.c }] : [],
      consecutiveLosses,
      lastLossAt,
      newOrdersToday: ordersToday,
      correlations: {},
      feeBps: costs.feeBps,
      market: {
        instrument,
        referencePrice: bar.c,
        dataAsOf: close,
        maxDataAgeMs: limits.maxDataAgeBars * barMs,
        atr: snapshot.atr14,
        avgDollarVolume: snapshot.avgDollarVolume20,
        bid: null,
        ask: null,
      },
    });
    if (!order) {
      rejected += 1;
      for (const c of verdict.checks.filter((x: RiskCheck) => x.severity === 'block' && !x.passed)) {
        rejectionsByRule[c.rule] = (rejectionsByRule[c.rule] ?? 0) + 1;
      }
      continue;
    }
    if (!order.reduceOnly) ordersToday += 1;
    pending = {
      side: order.side,
      quantity: order.quantity,
      stop: order.stopLoss,
      target: order.takeProfit,
      expiresAt: order.expiresAt,
    };
  }

  return {
    trades,
    equity,
    metrics: computeMetrics(equity, trades, barsPerYear(timeframe)),
    decisions,
    rejected,
    rejectionsByRule,
    haltedAt,
    warnings,
  };
}

function emptyResult(initialCash: number, warnings: string[]): BacktestResult {
  return {
    trades: [],
    equity: [],
    metrics: computeMetrics([{ t: 0, equity: initialCash }], [], 365),
    decisions: 0,
    rejected: 0,
    rejectionsByRule: {},
    haltedAt: null,
    warnings,
  };
}

export const eventDrivenEngine: BacktestEngine = { run: runBacktest };
