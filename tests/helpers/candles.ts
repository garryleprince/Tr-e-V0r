import type { Candle } from '../../src/core/domain/market';
import { TIMEFRAME_MS, type Timeframe } from '../../src/core/domain/time';

/**
 * SYNTHETIC candles for unit tests only.
 *
 * A seeded geometric random walk: deterministic, so tests are reproducible, and
 * obviously not market data. Nothing in `src/` imports this file.
 */
export function syntheticCandles(opts: {
  n: number;
  start?: number;
  tf?: Timeframe;
  startPrice?: number;
  drift?: number;
  vol?: number;
  seed?: number;
  volume?: number;
}): Candle[] {
  const { n, tf = '1d', startPrice = 100, drift = 0, vol = 0.02, seed = 42, volume = 1_000_000 } = opts;
  const start = opts.start ?? Date.UTC(2024, 0, 1);
  const rand = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out: Candle[] = [];
  let prev = startPrice;
  for (let i = 0; i < n; i++) {
    const o = prev;
    const c = o * Math.exp(drift + vol * gauss());
    const h = Math.max(o, c) * (1 + Math.abs(vol * gauss()) / 2);
    const l = Math.min(o, c) * (1 - Math.abs(vol * gauss()) / 2);
    out.push({ t: start + i * TIMEFRAME_MS[tf], o, h, l, c, v: volume * (0.5 + rand()) });
    prev = c;
  }
  return out;
}

/** Candles whose closes follow a given list; highs/lows hug the body. */
export function candlesFromCloses(closes: readonly number[], tf: Timeframe = '1d', start = Date.UTC(2024, 0, 1)): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    return { t: start + i * TIMEFRAME_MS[tf], o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1000 };
  });
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
