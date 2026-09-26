import type { Candle } from '../domain/market';

/**
 * Technical indicators.
 *
 * Every function returns an array aligned with its input: index `i` holds the
 * value computed from inputs `0..i` only, and `NaN` where not enough history
 * exists yet. Nothing ever reads index `i + 1`, so an indicator can never leak
 * the future into a decision taken at bar `i`.
 *
 * Conventions (documented because implementations differ in the wild):
 * - EMA is seeded with the SMA of its first `period` values.
 * - RSI and ATR use Wilder's smoothing (alpha = 1/period), seeded with the plain
 *   mean of the first `period` changes / true ranges — Wilder's original method.
 * - Bollinger bands use the population standard deviation (ddof = 0).
 */

const nanArray = (n: number): number[] => new Array<number>(n).fill(Number.NaN);

export function sma(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = nanArray(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = nanArray(values.length);
  const alpha = 2 / (period + 1);
  // Skip leading NaNs so an EMA can be chained on another indicator (MACD signal).
  let start = 0;
  while (start < values.length && Number.isNaN(values[start]!)) start++;
  if (values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i]!;
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = alpha * values[i]! + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. The first value appears at index `period`. */
export function rsi(closes: readonly number[], period = 14): number[] {
  assertPeriod(period);
  const out = nanArray(closes.length);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** True range. The first bar has no previous close, so it is high − low. */
export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((k, i) => {
    if (i === 0) return k.h - k.l;
    const prevClose = candles[i - 1]!.c;
    return Math.max(k.h - k.l, Math.abs(k.h - prevClose), Math.abs(k.l - prevClose));
  });
}

/** Wilder's ATR. The first value appears at index `period`. */
export function atr(candles: readonly Candle[], period = 14): number[] {
  assertPeriod(period);
  const tr = trueRange(candles);
  const out = nanArray(candles.length);
  if (candles.length <= period) return out;
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i]!;
  let prev = seed / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export interface MacdSeries {
  readonly line: number[];
  readonly signal: number[];
  readonly histogram: number[];
}

export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => fastEma[i]! - slowEma[i]!);
  const signal = ema(line, signalPeriod);
  const histogram = line.map((v, i) => v - signal[i]!);
  return { line, signal, histogram };
}

export function rollingStd(values: readonly number[], period: number, ddof: 0 | 1 = 1): number[] {
  assertPeriod(period);
  const out = nanArray(values.length);
  if (period - ddof <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j]!;
    mean /= period;
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (values[j]! - mean) ** 2;
    out[i] = Math.sqrt(ss / (period - ddof));
  }
  return out;
}

export interface BollingerSeries {
  readonly middle: number[];
  readonly upper: number[];
  readonly lower: number[];
  /** (upper − lower) / middle — a scale-free measure of volatility. */
  readonly bandwidth: number[];
}

export function bollinger(closes: readonly number[], period = 20, k = 2): BollingerSeries {
  const middle = sma(closes, period);
  const sd = rollingStd(closes, period, 0);
  const upper = middle.map((m, i) => m + k * sd[i]!);
  const lower = middle.map((m, i) => m - k * sd[i]!);
  const bandwidth = middle.map((m, i) => (upper[i]! - lower[i]!) / m);
  return { middle, upper, lower, bandwidth };
}

/** Rate of change over `n` bars: c[i] / c[i − n] − 1. */
export function roc(closes: readonly number[], n: number): number[] {
  assertPeriod(n);
  return closes.map((c, i) => (i >= n ? c / closes[i - n]! - 1 : Number.NaN));
}

/** Log returns aligned with the input; index 0 is NaN. */
export function logReturns(closes: readonly number[]): number[] {
  return closes.map((c, i) => (i === 0 ? Number.NaN : Math.log(c / closes[i - 1]!)));
}

/** Highest high and lowest low over the last `n` bars, including the current one. */
export function donchian(candles: readonly Candle[], n: number): { high: number[]; low: number[] } {
  assertPeriod(n);
  const high = nanArray(candles.length);
  const low = nanArray(candles.length);
  for (let i = n - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j]!.h);
      lo = Math.min(lo, candles[j]!.l);
    }
    high[i] = hi;
    low[i] = lo;
  }
  return { high, low };
}

/** Pearson correlation of two equal-length samples; NaN when undefined. */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return Number.NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return Number.NaN;
  return cov / Math.sqrt(va * vb);
}

export interface PriceLevel {
  readonly price: number;
  readonly kind: 'support' | 'resistance';
  /** How many confirmed swing points were merged into this level. */
  readonly touches: number;
  /** Open time of the most recent swing point in the cluster. */
  readonly lastTouch: number;
}

/**
 * Support and resistance from confirmed swing points.
 *
 * A swing high at `i` is a bar whose high is the maximum of `[i − k, i + k]`.
 * It is only *confirmed* once bar `i + k` exists, so the most recent `k` bars
 * can never produce a level — the level would otherwise depend on bars that had
 * not happened yet at `i`. Nearby swing points (within `mergeDistance`) are
 * merged into one level.
 */
export function swingLevels(
  candles: readonly Candle[],
  referencePrice: number,
  mergeDistance: number,
  k = 3,
  lookback = 120,
): { supports: PriceLevel[]; resistances: PriceLevel[] } {
  const start = Math.max(k, candles.length - lookback);
  const points: { price: number; t: number }[] = [];
  for (let i = start; i < candles.length - k; i++) {
    const bar = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j]!.h > bar.h) isHigh = false;
      if (candles[j]!.l < bar.l) isLow = false;
    }
    if (isHigh) points.push({ price: bar.h, t: bar.t });
    if (isLow) points.push({ price: bar.l, t: bar.t });
  }
  points.sort((a, b) => a.price - b.price);

  const clusters: { sum: number; n: number; lastTouch: number }[] = [];
  for (const p of points) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p.price - last.sum / last.n) <= mergeDistance) {
      last.sum += p.price;
      last.n += 1;
      last.lastTouch = Math.max(last.lastTouch, p.t);
    } else {
      clusters.push({ sum: p.price, n: 1, lastTouch: p.t });
    }
  }

  const levels = clusters.map((c) => ({ price: c.sum / c.n, touches: c.n, lastTouch: c.lastTouch }));
  const supports = levels
    .filter((l) => l.price < referencePrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3)
    .map((l) => ({ ...l, kind: 'support' as const }));
  const resistances = levels
    .filter((l) => l.price > referencePrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .map((l) => ({ ...l, kind: 'resistance' as const }));
  return { supports, resistances };
}

/** Last finite value of a series, or NaN. */
export function last(values: readonly number[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i]!)) return values[i]!;
  }
  return Number.NaN;
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`période invalide : ${period}`);
  }
}
