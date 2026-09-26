import { DAY_MS } from '../domain/time';
import type { ClosedTrade } from '../domain/trading';

/**
 * Performance metrics, shared by the backtest and the paper-trading screen so
 * that one definition serves every number the user sees.
 *
 * Returns are compounded (geometric), because the account compounds; Qlib's
 * default arithmetic accumulation is deliberately not used. A metric that cannot
 * be computed honestly (too few points, no loss to divide by) is `null`.
 */

export interface EquityPoint {
  readonly t: number;
  readonly equity: number;
  /** Market value of open positions / equity, 0..1. Optional. */
  readonly exposure?: number;
}

export interface PerformanceMetrics {
  readonly startEquity: number;
  readonly endEquity: number;
  readonly totalReturn: number;
  readonly cagr: number | null;
  readonly volatility: number | null;
  readonly sharpe: number | null;
  readonly sortino: number | null;
  readonly maxDrawdown: number;
  readonly maxDrawdownDurationDays: number;
  readonly calmar: number | null;
  readonly trades: number;
  readonly winRate: number | null;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
  readonly profitFactor: number | null;
  readonly expectancy: number | null;
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly averageExposure: number | null;
  readonly monthly: readonly { readonly month: string; readonly return: number }[];
}

/**
 * Below these, annualised figures are noise dressed as precision: 3 returns
 * 10 seconds apart can "annualise" to a Sharpe of −130. They are reported as
 * null (shown "—") rather than computed.
 */
export const MIN_RETURN_OBSERVATIONS = 30;
export const MIN_SPAN_DAYS_FOR_CAGR = 30;

export function computeMetrics(
  curve: readonly EquityPoint[],
  trades: readonly ClosedTrade[],
  periodsPerYear: number,
  riskFreeRate = 0,
): PerformanceMetrics {
  const first = curve[0];
  const last = curve[curve.length - 1];
  const startEquity = first?.equity ?? 0;
  const endEquity = last?.equity ?? 0;
  const totalReturn = startEquity > 0 ? endEquity / startEquity - 1 : 0;

  const spanMs = first && last ? last.t - first.t : 0;
  const years = spanMs / (365.25 * DAY_MS);
  const cagr =
    spanMs >= MIN_SPAN_DAYS_FOR_CAGR * DAY_MS && startEquity > 0 && endEquity > 0 ? (endEquity / startEquity) ** (1 / years) - 1 : null;

  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!.equity;
    if (prev > 0) returns.push(curve[i]!.equity / prev - 1);
  }
  const rfPerPeriod = (1 + riskFreeRate) ** (1 / periodsPerYear) - 1;
  const excess = returns.map((r) => r - rfPerPeriod);
  const enough = excess.length >= MIN_RETURN_OBSERVATIONS;
  const mean = enough ? avg(excess) : null;
  const sd = enough ? stdev(excess) : null;
  const volatility = sd === null ? null : sd * Math.sqrt(periodsPerYear);
  const sharpe = mean !== null && sd !== null && sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null;
  const downside = enough ? Math.sqrt(avg(excess.map((r) => Math.min(r, 0) ** 2))!) : null;
  const sortino =
    mean !== null && downside !== null && downside > 0 ? (mean / downside) * Math.sqrt(periodsPerYear) : null;

  const { maxDrawdown, maxDurationMs } = drawdown(curve);
  const calmar = cagr !== null && maxDrawdown > 0 ? cagr / maxDrawdown : null;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = sum(wins.map((t) => t.pnl));
  const grossLoss = -sum(losses.map((t) => t.pnl));

  const exposures = curve.map((p) => p.exposure).filter((e): e is number => e !== undefined);

  return {
    startEquity,
    endEquity,
    totalReturn,
    cagr,
    volatility,
    sharpe,
    sortino,
    maxDrawdown,
    maxDrawdownDurationDays: maxDurationMs / DAY_MS,
    calmar,
    trades: trades.length,
    winRate: trades.length > 0 ? wins.length / trades.length : null,
    avgWin: wins.length > 0 ? grossProfit / wins.length : null,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancy: trades.length > 0 ? sum(trades.map((t) => t.pnl)) / trades.length : null,
    grossProfit,
    grossLoss,
    averageExposure: exposures.length > 0 ? avg(exposures) : null,
    monthly: monthlyReturns(curve),
  };
}

/** Maximum peak-to-trough decline (fraction) and the longest time spent under a peak. */
export function drawdown(curve: readonly EquityPoint[]): { maxDrawdown: number; maxDurationMs: number } {
  let peak = -Infinity;
  let peakT = 0;
  let maxDrawdown = 0;
  let maxDurationMs = 0;
  for (const p of curve) {
    if (p.equity >= peak) {
      peak = p.equity;
      peakT = p.t;
    } else {
      maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
      maxDurationMs = Math.max(maxDurationMs, p.t - peakT);
    }
  }
  return { maxDrawdown, maxDurationMs };
}

/** Drawdown series (fraction below the running peak) for charts. */
export function drawdownSeries(curve: readonly EquityPoint[]): { t: number; drawdown: number }[] {
  let peak = -Infinity;
  return curve.map((p) => {
    peak = Math.max(peak, p.equity);
    return { t: p.t, drawdown: peak > 0 ? (p.equity - peak) / peak : 0 };
  });
}

function monthlyReturns(curve: readonly EquityPoint[]): { month: string; return: number }[] {
  const out: { month: string; return: number }[] = [];
  let currentMonth: string | null = null;
  let base = curve[0]?.equity ?? 0;
  let lastEquity = base;
  for (const p of curve) {
    const month = new Date(p.t).toISOString().slice(0, 7);
    if (currentMonth !== null && month !== currentMonth) {
      out.push({ month: currentMonth, return: base > 0 ? lastEquity / base - 1 : 0 });
      base = lastEquity;
    }
    currentMonth = month;
    lastEquity = p.equity;
  }
  if (currentMonth !== null) out.push({ month: currentMonth, return: base > 0 ? lastEquity / base - 1 : 0 });
  return out;
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function avg(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : sum(xs) / xs.length;
}

function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = avg(xs)!;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}
