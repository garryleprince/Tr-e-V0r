import { z } from 'zod';

/**
 * Instruments and candles.
 *
 * An instrument id is `provider:symbol` (e.g. `coinbase:BTC-USD`,
 * `alphavantage:SPY`). The identity is resolved once, deterministically, and
 * passed to every agent — so no agent can "recognise" a different asset from the
 * shape of a chart (TradingAgents #814).
 */

export const AssetClassSchema = z.enum(['crypto', 'equity', 'etf', 'fx']);
export type AssetClass = z.infer<typeof AssetClassSchema>;

export const InstrumentSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9.\-/^=]+$/, 'identifiant attendu : fournisseur:symbole'),
  provider: z.string().min(1),
  symbol: z.string().min(1),
  displayName: z.string().min(1),
  assetClass: AssetClassSchema,
  quoteCurrency: z.string().min(3).max(4),
  /** Smallest price step. Prices sent to a venue are rounded to it. */
  priceIncrement: z.number().positive(),
  /** Smallest quantity step. Quantities are rounded DOWN to it. */
  sizeIncrement: z.number().positive(),
  /** Smallest order value the venue accepts, in quote currency. */
  minNotional: z.number().nonnegative(),
  active: z.boolean().default(true),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

/** One OHLCV bar. `t` is the bar's OPEN time in ms UTC. */
export const CandleSchema = z
  .object({
    t: z.number().int().nonnegative(),
    o: z.number().positive(),
    h: z.number().positive(),
    l: z.number().positive(),
    c: z.number().positive(),
    v: z.number().nonnegative(),
  })
  .refine((k) => k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c), {
    message: 'bougie incohérente : le plus haut et le plus bas doivent encadrer ouverture et clôture',
  });
export type Candle = z.infer<typeof CandleSchema>;

/** Best bid/ask snapshot, when a provider offers one. */
export interface Quote {
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number;
  /** Time the quote was observed, ms UTC. */
  readonly ts: number;
}

/**
 * Keeps only valid candles, sorted by time, one per open time.
 *
 * Providers occasionally return duplicates, zero-volume placeholders with
 * nonsense prices, or reverse chronological order. Invalid rows are dropped and
 * counted, never repaired: a repaired price is an invented price.
 */
export function normaliseCandles(rows: readonly unknown[]): { candles: Candle[]; dropped: number } {
  const byTime = new Map<number, Candle>();
  let dropped = 0;
  for (const row of rows) {
    const parsed = CandleSchema.safeParse(row);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    byTime.set(parsed.data.t, parsed.data);
  }
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  return { candles, dropped };
}
