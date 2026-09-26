import { z } from 'zod';

/**
 * Units of time the platform works in.
 *
 * Every timestamp in the system is an integer number of milliseconds since the
 * Unix epoch, UTC. A candle is identified by its OPEN time; it becomes usable
 * only once its CLOSE time (open + duration) has passed. That single rule is what
 * keeps a still-forming bar out of every analysis (look-ahead prevention,
 * NautilusTrader's "ts_init = close of the interval" convention).
 */

export const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof TimeframeSchema>;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '15m': 15 * MINUTE_MS,
  '1h': HOUR_MS,
  '4h': 4 * HOUR_MS,
  '1d': DAY_MS,
};

/** Bars per year, used to annualise volatility and Sharpe ratios. */
export function barsPerYear(tf: Timeframe, tradingDaysPerYear = 365): number {
  return (tradingDaysPerYear * DAY_MS) / TIMEFRAME_MS[tf];
}

/** Close time of the bar that opened at `openTime`. */
export function barCloseTime(openTime: number, tf: Timeframe): number {
  return openTime + TIMEFRAME_MS[tf];
}

/** Whether the bar that opened at `openTime` has fully formed by `now`. */
export function isBarClosed(openTime: number, tf: Timeframe, now: number): boolean {
  return barCloseTime(openTime, tf) <= now;
}

/** Start of the UTC day containing `t`. */
export function utcDayStart(t: number): number {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

/** ISO date (YYYY-MM-DD, UTC) for display and daily grouping. */
export function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
