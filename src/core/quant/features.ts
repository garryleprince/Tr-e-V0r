import type { Candle } from '../domain/market';
import { barCloseTime, barsPerYear, type Timeframe } from '../domain/time';
import {
  atr,
  bollinger,
  donchian,
  ema,
  logReturns,
  macd,
  roc,
  rollingStd,
  rsi,
  sma,
  swingLevels,
  type PriceLevel,
} from './indicators';

/**
 * The technical snapshot: every number an agent may cite.
 *
 * This is the "verified snapshot" idea from TradingAgents made structural: the
 * LLM never computes or fetches a price or an indicator, it receives this object
 * and interprets it. `null` means "not enough history", never zero.
 */

export type TrendRegime = 'up' | 'down' | 'range';
export type VolatilityRegime = 'low' | 'normal' | 'high';

export interface TechnicalSnapshot {
  readonly instrumentId: string;
  readonly timeframe: Timeframe;
  /** Close time of the last CLOSED bar used — nothing after it was visible. */
  readonly asOf: number;
  readonly barsUsed: number;
  readonly lastClose: number;
  readonly change1: number | null;
  readonly change20: number | null;
  readonly sma20: number | null;
  readonly sma50: number | null;
  readonly sma200: number | null;
  readonly ema12: number | null;
  readonly ema26: number | null;
  readonly macd: { readonly line: number; readonly signal: number; readonly histogram: number } | null;
  readonly rsi14: number | null;
  readonly atr14: number | null;
  /** ATR as a fraction of the last close. */
  readonly atrPct: number | null;
  readonly bollinger: { readonly upper: number; readonly middle: number; readonly lower: number; readonly bandwidth: number } | null;
  /** Annualised standard deviation of log returns over 20 bars. */
  readonly realizedVol20: number | null;
  /** How unusual the last bar's volume is versus the previous 20 (z-score). */
  readonly volumeZ20: number | null;
  /** Average traded value (close × volume) per bar over 20 bars, quote currency. */
  readonly avgDollarVolume20: number | null;
  readonly donchian20: { readonly high: number; readonly low: number } | null;
  readonly supports: readonly PriceLevel[];
  readonly resistances: readonly PriceLevel[];
  readonly trend: TrendRegime;
  /** Slope of SMA50 over 10 bars, as a fraction per bar. */
  readonly trendSlope: number | null;
  readonly volatilityRegime: VolatilityRegime;
  /** Percentile (0..1) of the current ATR% among the last 100 bars. */
  readonly atrPercentile: number | null;
  /** Deterministic composite score in [-1, 1]; positive is bullish. */
  readonly technicalScore: number;
  readonly scoreComponents: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export const MIN_BARS_FOR_SNAPSHOT = 30;

/**
 * Computes the snapshot from CLOSED candles, oldest first.
 *
 * The caller is responsible for passing only closed bars (see
 * `server/data/candle-service`); `asOf` is derived from the last one.
 */
export function computeSnapshot(
  instrumentId: string,
  timeframe: Timeframe,
  candles: readonly Candle[],
): TechnicalSnapshot {
  if (candles.length < MIN_BARS_FOR_SNAPSHOT) {
    throw new RangeError(
      `historique insuffisant : ${candles.length} bougies, ${MIN_BARS_FOR_SNAPSHOT} minimum`,
    );
  }
  const warnings: string[] = [];
  const n = candles.length;
  const closes = candles.map((k) => k.c);
  const lastBar = candles[n - 1]!;
  const lastClose = lastBar.c;
  const at = (series: readonly number[]): number | null => finite(series[n - 1]);

  const sma20 = at(sma(closes, 20));
  const sma50 = n >= 50 ? at(sma(closes, 50)) : null;
  const sma200 = n >= 200 ? at(sma(closes, 200)) : null;
  if (sma200 === null) warnings.push(`MM200 indisponible : ${n} bougies (200 requises)`);
  if (sma50 === null) warnings.push(`MM50 indisponible : ${n} bougies (50 requises)`);

  const macdSeries = macd(closes);
  const macdLine = at(macdSeries.line);
  const macdSignal = at(macdSeries.signal);
  const atrSeries = atr(candles, 14);
  const atr14 = at(atrSeries);
  const bb = bollinger(closes, 20, 2);
  const bbMiddle = at(bb.middle);

  const returns = logReturns(closes);
  const vol20 = at(rollingStd(returns, 20, 1));
  const realizedVol20 = vol20 === null ? null : vol20 * Math.sqrt(barsPerYear(timeframe));

  const volumes = candles.map((k) => k.v);
  const volumeZ20 = zScoreOfLast(volumes, 20);
  const dollarVolumes = candles.map((k) => k.c * k.v);
  const avgDollarVolume20 = at(sma(dollarVolumes, 20));

  const dc = donchian(candles, 20);
  const dcHigh = at(dc.high);
  const dcLow = at(dc.low);

  const mergeDistance = (atr14 ?? lastClose * 0.01) * 0.5;
  const levels = swingLevels(candles, lastClose, mergeDistance);

  // Trend: price and moving-average alignment, confirmed by the SMA50 slope.
  const sma50Series = sma(closes, 50);
  const trendSlope =
    n >= 60 && Number.isFinite(sma50Series[n - 11]!)
      ? (sma50Series[n - 1]! / sma50Series[n - 11]! - 1) / 10
      : null;
  const trend = classifyTrend(lastClose, sma50, sma200 ?? sma50, trendSlope);

  // Volatility regime: where today's ATR% sits among the last 100 bars.
  const atrPctSeries = atrSeries.map((a, i) => a / closes[i]!);
  const atrPct = atr14 === null ? null : atr14 / lastClose;
  const atrPercentile = percentileOfLast(atrPctSeries, 100);
  const volatilityRegime: VolatilityRegime =
    atrPercentile === null ? 'normal' : atrPercentile >= 0.8 ? 'high' : atrPercentile <= 0.2 ? 'low' : 'normal';

  const rsi14 = at(rsi(closes, 14));
  const change20 = at(roc(closes, 20));
  const { score, components } = technicalScore({
    lastClose,
    sma50,
    sma200,
    trendSlope,
    macdHistogram: macdLine !== null && macdSignal !== null ? macdLine - macdSignal : null,
    atr14,
    rsi14,
    change20,
  });

  return {
    instrumentId,
    timeframe,
    asOf: barCloseTime(lastBar.t, timeframe),
    barsUsed: n,
    lastClose,
    change1: at(roc(closes, 1)),
    change20,
    sma20,
    sma50,
    sma200,
    ema12: at(ema(closes, 12)),
    ema26: at(ema(closes, 26)),
    macd:
      macdLine !== null && macdSignal !== null
        ? { line: macdLine, signal: macdSignal, histogram: macdLine - macdSignal }
        : null,
    rsi14,
    atr14,
    atrPct,
    bollinger:
      bbMiddle !== null
        ? { upper: bb.upper[n - 1]!, middle: bbMiddle, lower: bb.lower[n - 1]!, bandwidth: bb.bandwidth[n - 1]! }
        : null,
    realizedVol20,
    volumeZ20,
    avgDollarVolume20,
    donchian20: dcHigh !== null && dcLow !== null ? { high: dcHigh, low: dcLow } : null,
    supports: levels.supports,
    resistances: levels.resistances,
    trend,
    trendSlope,
    volatilityRegime,
    atrPercentile,
    technicalScore: score,
    scoreComponents: components,
    warnings,
  };
}

function classifyTrend(
  close: number,
  mid: number | null,
  long: number | null,
  slope: number | null,
): TrendRegime {
  if (mid === null || long === null) return 'range';
  const risingEnough = slope !== null && slope > 0;
  const fallingEnough = slope !== null && slope < 0;
  if (close > mid && mid >= long && risingEnough) return 'up';
  if (close < mid && mid <= long && fallingEnough) return 'down';
  return 'range';
}

interface ScoreInputs {
  lastClose: number;
  sma50: number | null;
  sma200: number | null;
  trendSlope: number | null;
  macdHistogram: number | null;
  atr14: number | null;
  rsi14: number | null;
  change20: number | null;
}

/**
 * A transparent composite in [-1, 1]. Each component is bounded in [-1, 1] and
 * reported, so a reader can trace exactly why the score is what it is. Weights
 * are fixed here and are NOT tuned on any data: this is a baseline, not an alpha.
 */
export function technicalScore(x: ScoreInputs): { score: number; components: Record<string, number> } {
  const components: Record<string, number> = {};
  const weights: Record<string, number> = {};
  const add = (name: string, value: number | null, weight: number) => {
    if (value === null || !Number.isFinite(value)) return;
    components[name] = clamp(value, -1, 1);
    weights[name] = weight;
  };

  const scale = x.atr14 ?? x.lastClose * 0.02;
  // Distance to the averages, measured in ATRs, saturating at 3 ATR.
  add('prix_vs_mm50', x.sma50 === null ? null : (x.lastClose - x.sma50) / (3 * scale), 0.25);
  add('prix_vs_mm200', x.sma200 === null ? null : (x.lastClose - x.sma200) / (3 * scale), 0.2);
  // SMA50 slope of 0.5 % per bar saturates.
  add('pente_mm50', x.trendSlope === null ? null : x.trendSlope / 0.005, 0.2);
  // MACD histogram in ATR units.
  add('macd', x.macdHistogram === null ? null : x.macdHistogram / scale, 0.15);
  // RSI: momentum reading, centred on 50; extremes are not rewarded further.
  add('rsi', x.rsi14 === null ? null : (x.rsi14 - 50) / 25, 0.1);
  add('momentum_20', x.change20 === null ? null : x.change20 / 0.2, 0.1);

  let total = 0;
  let weightSum = 0;
  for (const [name, value] of Object.entries(components)) {
    total += value * weights[name]!;
    weightSum += weights[name]!;
  }
  const score = weightSum === 0 ? 0 : total / weightSum;
  return { score: round(score, 4), components };
}

function zScoreOfLast(values: readonly number[], window: number): number | null {
  const n = values.length;
  if (n < window + 1) return null;
  const prior = values.slice(n - 1 - window, n - 1);
  const mean = prior.reduce((a, b) => a + b, 0) / window;
  const sd = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / (window - 1));
  if (sd === 0) return null;
  return (values[n - 1]! - mean) / sd;
}

function percentileOfLast(values: readonly number[], window: number): number | null {
  const finiteValues = values.filter((v) => Number.isFinite(v));
  if (finiteValues.length < 20) return null;
  const sample = finiteValues.slice(-window);
  const current = sample[sample.length - 1]!;
  const below = sample.filter((v) => v < current).length;
  return below / (sample.length - 1 || 1);
}

function finite(v: number | undefined): number | null {
  return v !== undefined && Number.isFinite(v) ? v : null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
