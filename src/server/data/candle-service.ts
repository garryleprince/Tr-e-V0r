import { normaliseCandles, type Candle, type Instrument, type Quote } from '../../core/domain/market';
import { barCloseTime, DAY_MS, isBarClosed, MINUTE_MS, TIMEFRAME_MS, type Timeframe } from '../../core/domain/time';
import { getCandles, getFetchRecord, getQuote, putFetchRecord, putQuote, upsertCandles } from '../db/core';
import { errorMessage, log } from '../util';
import { DAILY_EQUITY_MAX_AGE_MS } from './providers';
import { ProviderError, type MarketDataProvider } from './types';

/**
 * Data engine: the only way the rest of the server obtains market data.
 *
 * - Serves CLOSED bars only. The still-forming bar is dropped here, once, for
 *   every consumer (look-ahead prevention).
 * - Caches in D1 and refreshes on a per-timeframe schedule, with a much slower
 *   cadence for rate-limited vendors (Alpha Vantage free tier: 25 calls/day).
 * - Tries providers in order and falls back; if all fail it serves the cache
 *   and SAYS so. It never invents a bar.
 */

const REFRESH_MS: Record<Timeframe, number> = {
  '15m': 5 * MINUTE_MS,
  '1h': 15 * MINUTE_MS,
  '4h': 30 * MINUTE_MS,
  '1d': 60 * MINUTE_MS,
};
const SLOW_VENDOR_REFRESH_MS = 6 * 60 * MINUTE_MS;
const QUOTE_TTL_MS = 60_000;

export interface CandleResult {
  readonly candles: Candle[];
  readonly source: string | null;
  readonly fromCache: boolean;
  readonly warnings: string[];
  /** Close time of the last candle (asOf), or null when empty. */
  readonly asOf: number | null;
}

export class CandleService {
  constructor(
    private readonly db: D1Database,
    private readonly providers: readonly MarketDataProvider[],
    private readonly now: () => number,
  ) {}

  providersFor(instrument: Instrument, tf: Timeframe): MarketDataProvider[] {
    const matching = this.providers.filter((p) => p.supports(instrument, tf));
    // The instrument's own provider first, then any fallback.
    return matching.sort((a, b) => Number(b.id === instrument.provider) - Number(a.id === instrument.provider));
  }

  async getClosedCandles(
    instrument: Instrument,
    tf: Timeframe,
    limit: number,
    opts: { force?: boolean } = {},
  ): Promise<CandleResult> {
    const now = this.now();
    const warnings: string[] = [];
    const cached = await getCandles(this.db, instrument.id, tf, limit);
    const record = await getFetchRecord(this.db, instrument.id, tf);
    const providers = this.providersFor(instrument, tf).filter((p) => p.available?.() ?? true);
    const slow = providers[0]?.id === 'alphavantage';
    const minInterval = slow ? SLOW_VENDOR_REFRESH_MS : REFRESH_MS[tf];
    const lastCached = cached.candles[cached.candles.length - 1];
    const expectedLatestClose = expectedLatestBarClose(instrument, tf, now);
    const behind = !lastCached || barCloseTime(lastCached.t, tf) < expectedLatestClose;
    const due = !record || now - record.fetchedAt >= minInterval;
    const needRefresh = cached.candles.length < Math.min(limit, 60) || (behind && due) || (opts.force && due);

    if (!needRefresh) {
      return { candles: cached.candles, source: cached.source, fromCache: true, warnings, asOf: asOf(cached.candles, tf) };
    }
    if (providers.length === 0) {
      warnings.push(`aucun fournisseur ne couvre ${instrument.id} en ${tf}`);
      return { candles: cached.candles, source: cached.source, fromCache: true, warnings, asOf: asOf(cached.candles, tf) };
    }

    for (const provider of providers) {
      try {
        const raw = await provider.fetchCandles(instrument, tf, limit);
        const { candles, dropped } = normaliseCandles(raw);
        const closed = candles.filter((k) => isBarClosed(k.t, tf, now));
        if (dropped > 0) warnings.push(`${dropped} bougie(s) invalide(s) ignorée(s) (${provider.label})`);
        if (closed.length === 0) throw new ProviderError(provider.id, 'aucune bougie clôturée', 'bad_payload');
        await upsertCandles(this.db, instrument.id, tf, closed, provider.id, now);
        await putFetchRecord(this.db, instrument.id, tf, { fetchedAt: now, source: provider.id, status: 'ok', detail: null });
        const fresh = await getCandles(this.db, instrument.id, tf, limit);
        return { candles: fresh.candles, source: provider.id, fromCache: false, warnings, asOf: asOf(fresh.candles, tf) };
      } catch (err) {
        const message = errorMessage(err);
        warnings.push(message);
        log('warn', 'market data provider failed', { provider: provider.id, instrument: instrument.id, tf, error: message });
        await putFetchRecord(this.db, instrument.id, tf, { fetchedAt: now, source: provider.id, status: 'error', detail: message.slice(0, 300) });
      }
    }
    if (cached.candles.length > 0) warnings.push('fournisseurs indisponibles : données en cache');
    return { candles: cached.candles, source: cached.source, fromCache: true, warnings, asOf: asOf(cached.candles, tf) };
  }

  /** Best bid/ask with a 60 s cache. Null when no provider offers quotes. */
  async getQuote(instrument: Instrument): Promise<(Quote & { source: string }) | null> {
    const now = this.now();
    const cached = await getQuote(this.db, instrument.id);
    if (cached && now - cached.fetchedAt < QUOTE_TTL_MS) return cached;
    for (const provider of this.providers.filter((p) => p.fetchQuote && p.supports(instrument, '1d'))) {
      try {
        const q = await provider.fetchQuote!(instrument);
        if (q) {
          await putQuote(this.db, instrument.id, q, provider.id, now);
          return { ...q, source: provider.id };
        }
      } catch (err) {
        log('warn', 'quote provider failed', { provider: provider.id, instrument: instrument.id, error: errorMessage(err) });
      }
    }
    return cached;
  }

  /** Maximum acceptable age of the last closed bar, per asset class. */
  static maxDataAgeMs(instrument: Instrument, tf: Timeframe, maxDataAgeBars: number): number {
    if ((instrument.assetClass === 'equity' || instrument.assetClass === 'etf') && tf === '1d') {
      // Weekends and holidays: a Friday bar is still the latest on Monday.
      return Math.max(DAILY_EQUITY_MAX_AGE_MS, maxDataAgeBars * TIMEFRAME_MS[tf]);
    }
    return maxDataAgeBars * TIMEFRAME_MS[tf];
  }
}

function asOf(candles: readonly Candle[], tf: Timeframe): number | null {
  const last = candles[candles.length - 1];
  return last ? barCloseTime(last.t, tf) : null;
}

/**
 * Close time of the most recent bar that should exist by `now`. Session markets
 * (equities, FX) publish no weekend daily bar: expecting one would re-query a
 * rate-limited vendor all weekend for nothing (25 calls a day on Alpha Vantage's
 * free tier). Holidays are not modelled: at worst a few extra calls a year.
 */
export function expectedLatestBarClose(instrument: Instrument, tf: Timeframe, now: number): number {
  const step = TIMEFRAME_MS[tf];
  let close = Math.floor(now / step) * step;
  if (tf === '1d' && instrument.assetClass !== 'crypto') {
    for (let i = 0; i < 3; i++) {
      const barDay = new Date(close - DAY_MS).getUTCDay();
      if (barDay !== 0 && barDay !== 6) break;
      close -= DAY_MS;
    }
  }
  return close;
}
