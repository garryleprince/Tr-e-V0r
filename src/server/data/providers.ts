import type { Candle, Instrument, Quote } from '../../core/domain/market';
import { DAY_MS, TIMEFRAME_MS, type Timeframe } from '../../core/domain/time';
import { getJson, ProviderError, type FetchLike, type MarketDataProvider } from './types';

/**
 * Market data adapters.
 *
 * - Coinbase Exchange: public, no key. Candles: [time(s), low, high, open, close, volume],
 *   newest first, at most 300 per request. Granularities 60, 300, 900, 3600, 21600, 86400 s
 *   (no 4 h: it is built by aggregating 1 h bars).
 * - Kraken: public, no key. OHLC rows: [time(s), open, high, low, close, vwap, volume, count],
 *   strings; the last row is the bar still forming. Used as fallback for crypto.
 * - Alpha Vantage: key required. Free tier: 25 requests/day, 1 request/second, and only
 *   the last 100 daily bars (`outputsize=full` is a premium feature, checked on
 *   2026-09-26) — so the 200-bar moving average is not available for equities on the free
 *   tier. US equities (`AAPL`), European equities with the exchange suffix (`MC.PAR`,
 *   `SAP.DEX`, `ASML.AMS`, verified 2026-09-27) and daily FX (`FX_DAILY`, EUR/USD).
 */

// ------------------------------------------------------------------ Coinbase

const COINBASE_GRANULARITY: Partial<Record<Timeframe, number>> = { '15m': 900, '1h': 3600, '1d': 86400 };

export class CoinbaseProvider implements MarketDataProvider {
  readonly id = 'coinbase';
  readonly label = 'Coinbase Exchange';
  constructor(private readonly fetcher: FetchLike, private readonly baseUrl = 'https://api.exchange.coinbase.com') {}

  supports(instrument: Instrument, tf: Timeframe): boolean {
    return instrument.assetClass === 'crypto' && (tf in COINBASE_GRANULARITY || tf === '4h');
  }

  async fetchCandles(instrument: Instrument, tf: Timeframe, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    if (tf === '4h') {
      const hourly = await this.fetchCandles(instrument, '1h', Math.min(limit * 4, 1200), signal);
      return aggregateCandles(hourly, TIMEFRAME_MS['1h'], TIMEFRAME_MS['4h']);
    }
    const granularity = COINBASE_GRANULARITY[tf];
    if (!granularity) throw new ProviderError(this.id, `unité ${tf} non prise en charge`, 'unsupported');
    const product = instrument.symbol;
    const out: Candle[] = [];
    let end = Date.now();
    // Page backwards, 300 bars at a time.
    while (out.length < limit) {
      const count = Math.min(300, limit - out.length);
      const start = end - count * granularity * 1000;
      const url = `${this.baseUrl}/products/${encodeURIComponent(product)}/candles?granularity=${granularity}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
      const payload = await getJson(this.fetcher, this.id, url, signal);
      if (!Array.isArray(payload)) throw new ProviderError(this.id, 'format de bougies inattendu', 'bad_payload');
      const page = payload.map(parseCoinbaseRow).filter((k): k is Candle => k !== null);
      if (page.length === 0) break;
      out.push(...page);
      end = start;
    }
    return out.sort((a, b) => a.t - b.t);
  }

  async fetchQuote(instrument: Instrument, signal?: AbortSignal): Promise<Quote | null> {
    const product = instrument.symbol;
    const p = (await getJson(this.fetcher, this.id, `${this.baseUrl}/products/${encodeURIComponent(product)}/ticker`, signal)) as Record<string, unknown>;
    const last = Number(p.price);
    if (!Number.isFinite(last) || last <= 0) throw new ProviderError(this.id, 'cotation invalide', 'bad_payload');
    return {
      bid: positiveOrNull(p.bid),
      ask: positiveOrNull(p.ask),
      last,
      ts: typeof p.time === 'string' ? Date.parse(p.time) : Date.now(),
    };
  }
}

export function parseCoinbaseRow(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [time, low, high, open, close, volume] = row.map(Number);
  if (![time, low, high, open, close, volume].every(Number.isFinite)) return null;
  return { t: time! * 1000, o: open!, h: high!, l: low!, c: close!, v: volume! };
}

// -------------------------------------------------------------------- Kraken

const KRAKEN_INTERVAL: Partial<Record<Timeframe, number>> = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
const KRAKEN_PAIRS: Record<string, string> = {
  'BTC-USD': 'XBTUSD',
  'ETH-USD': 'ETHUSD',
  'SOL-USD': 'SOLUSD',
  'XRP-USD': 'XRPUSD',
  'ADA-USD': 'ADAUSD',
  'DOGE-USD': 'XDGUSD',
  'AVAX-USD': 'AVAXUSD',
  'LINK-USD': 'LINKUSD',
  'DOT-USD': 'DOTUSD',
  // Fiat FX, fallback for the conversion rate when Alpha Vantage is unavailable.
  EURUSD: 'EURUSD',
};

export class KrakenProvider implements MarketDataProvider {
  readonly id = 'kraken';
  readonly label = 'Kraken';
  constructor(private readonly fetcher: FetchLike, private readonly baseUrl = 'https://api.kraken.com') {}

  supports(instrument: Instrument, tf: Timeframe): boolean {
    return (instrument.assetClass === 'crypto' || instrument.assetClass === 'fx') && tf in KRAKEN_INTERVAL && instrument.symbol in KRAKEN_PAIRS;
  }

  async fetchCandles(instrument: Instrument, tf: Timeframe, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    const interval = KRAKEN_INTERVAL[tf];
    const pair = KRAKEN_PAIRS[instrument.symbol];
    if (!interval || !pair) throw new ProviderError(this.id, `${instrument.symbol} ${tf} non pris en charge`, 'unsupported');
    const since = Math.floor((Date.now() - limit * interval * 60_000) / 1000);
    const payload = (await getJson(this.fetcher, this.id, `${this.baseUrl}/0/public/OHLC?pair=${pair}&interval=${interval}&since=${since}`, signal)) as {
      error?: unknown[];
      result?: Record<string, unknown>;
    };
    if (Array.isArray(payload.error) && payload.error.length > 0) {
      throw new ProviderError(this.id, String(payload.error[0]), 'http');
    }
    const series = Object.entries(payload.result ?? {}).find(([k]) => k !== 'last')?.[1];
    if (!Array.isArray(series)) throw new ProviderError(this.id, 'format OHLC inattendu', 'bad_payload');
    return series.map(parseKrakenRow).filter((k): k is Candle => k !== null).slice(-limit);
  }

  async fetchQuote(instrument: Instrument, signal?: AbortSignal): Promise<Quote | null> {
    const pair = KRAKEN_PAIRS[instrument.symbol];
    if (!pair) return null;
    const payload = (await getJson(this.fetcher, this.id, `${this.baseUrl}/0/public/Ticker?pair=${pair}`, signal)) as {
      result?: Record<string, { a?: string[]; b?: string[]; c?: string[] }>;
    };
    const t = Object.values(payload.result ?? {})[0];
    const last = Number(t?.c?.[0]);
    if (!t || !Number.isFinite(last)) throw new ProviderError(this.id, 'cotation invalide', 'bad_payload');
    return { bid: positiveOrNull(t.b?.[0]), ask: positiveOrNull(t.a?.[0]), last, ts: Date.now() };
  }
}

export function parseKrakenRow(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 7) return null;
  const t = Number(row[0]);
  const [o, h, l, c] = [row[1], row[2], row[3], row[4]].map(Number);
  const v = Number(row[6]);
  if (![t, o, h, l, c, v].every(Number.isFinite)) return null;
  return { t: t * 1000, o: o!, h: h!, l: l!, c: c!, v };
}

// ------------------------------------------------------------- Alpha Vantage

/** Spacing between two Alpha Vantage calls from this isolate (free tier: 1 per second). */
export const ALPHAVANTAGE_MIN_SPACING_MS = 1_100;
let avQueue: Promise<unknown> = Promise.resolve();
let avLastCall = 0;

export interface AlphaVantageOptions {
  /** Called before every request; throws when the daily quota is spent. */
  readonly beforeCall?: () => Promise<void>;
  readonly baseUrl?: string;
  /** Test hook: how to wait (defaults to a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = 'alphavantage';
  readonly label = 'Alpha Vantage';
  private readonly baseUrl: string;
  constructor(
    private readonly fetcher: FetchLike,
    private readonly apiKey: string | null,
    private readonly opts: AlphaVantageOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? 'https://www.alphavantage.co';
  }

  supports(instrument: Instrument, tf: Timeframe): boolean {
    return (instrument.assetClass === 'equity' || instrument.assetClass === 'etf' || instrument.assetClass === 'fx') && tf === '1d';
  }

  /** Optional source: without a key it is skipped instead of reporting an error. */
  available(): boolean {
    return this.apiKey !== null;
  }

  async fetchCandles(instrument: Instrument, tf: Timeframe, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    if (!this.apiKey) throw new ProviderError(this.id, 'clé ALPHAVANTAGE_API_KEY absente', 'not_configured');
    if (tf !== '1d') throw new ProviderError(this.id, `unité ${tf} non prise en charge`, 'unsupported');
    const key = encodeURIComponent(this.apiKey);
    if (instrument.assetClass === 'fx') {
      const [from, to] = [instrument.symbol.slice(0, 3), instrument.symbol.slice(3, 6)];
      const url = `${this.baseUrl}/query?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&outputsize=compact&apikey=${key}`;
      return parseAlphaVantageFxDaily(await this.call(url, signal)).slice(-limit);
    }
    const url = `${this.baseUrl}/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(instrument.symbol)}&outputsize=compact&apikey=${key}`;
    return parseAlphaVantageDaily(await this.call(url, signal)).slice(-limit);
  }

  /**
   * Calls are serialised and spaced (the free tier answers a burst with a
   * throttling notice), and counted against the daily quota before being sent.
   */
  private call(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const run = async () => {
      const wait = avLastCall + ALPHAVANTAGE_MIN_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      await this.opts.beforeCall?.();
      avLastCall = Date.now();
      return (await getJson(this.fetcher, this.id, url, signal)) as Record<string, unknown>;
    };
    const next = avQueue.then(run, run);
    avQueue = next.catch(() => undefined);
    return next;
  }
}

export function parseAlphaVantageDaily(payload: Record<string, unknown>): Candle[] {
  // Throttling and entitlement messages arrive as HTTP 200 with a text field.
  const notice = payload.Note ?? payload.Information ?? payload['Error Message'];
  if (typeof notice === 'string') {
    throw new ProviderError('alphavantage', notice.slice(0, 200), /frequency|limit|premium/i.test(notice) ? 'rate_limited' : 'http');
  }
  const series = payload['Time Series (Daily)'];
  if (!series || typeof series !== 'object') throw new ProviderError('alphavantage', 'série journalière absente', 'bad_payload');
  const out: Candle[] = [];
  for (const [date, row] of Object.entries(series as Record<string, Record<string, string>>)) {
    // A daily equity bar is timestamped at 00:00 UTC of its session date. It is
    // therefore considered closed only at 00:00 UTC the next day — after the US
    // close — which can never make it visible too early.
    const t = Date.parse(`${date}T00:00:00Z`);
    const k = {
      t,
      o: Number(row['1. open']),
      h: Number(row['2. high']),
      l: Number(row['3. low']),
      c: Number(row['4. close']),
      v: Number(row['5. volume']),
    };
    if ([k.t, k.o, k.h, k.l, k.c, k.v].every(Number.isFinite)) out.push(k);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** FX_DAILY: open/high/low/close, no volume (recorded as 0). */
export function parseAlphaVantageFxDaily(payload: Record<string, unknown>): Candle[] {
  const notice = payload.Note ?? payload.Information ?? payload['Error Message'];
  if (typeof notice === 'string') {
    throw new ProviderError('alphavantage', notice.slice(0, 200), /frequency|limit|premium/i.test(notice) ? 'rate_limited' : 'http');
  }
  const series = payload['Time Series FX (Daily)'];
  if (!series || typeof series !== 'object') throw new ProviderError('alphavantage', 'série de change absente', 'bad_payload');
  const out: Candle[] = [];
  for (const [date, row] of Object.entries(series as Record<string, Record<string, string>>)) {
    const k = {
      t: Date.parse(`${date}T00:00:00Z`),
      o: Number(row['1. open']),
      h: Number(row['2. high']),
      l: Number(row['3. low']),
      c: Number(row['4. close']),
      v: 0,
    };
    if ([k.t, k.o, k.h, k.l, k.c].every(Number.isFinite)) out.push(k);
  }
  return out.sort((a, b) => a.t - b.t);
}

// -------------------------------------------------------------------- shared

/** Builds higher-timeframe bars from complete groups of lower-timeframe bars. */
export function aggregateCandles(candles: readonly Candle[], fromMs: number, toMs: number): Candle[] {
  const per = toMs / fromMs;
  const groups = new Map<number, Candle[]>();
  for (const k of candles) {
    const bucket = Math.floor(k.t / toMs) * toMs;
    const g = groups.get(bucket) ?? [];
    g.push(k);
    groups.set(bucket, g);
  }
  const out: Candle[] = [];
  for (const [t, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.length !== per) continue; // incomplete group: never publish a partial bar
    g.sort((a, b) => a.t - b.t);
    out.push({
      t,
      o: g[0]!.o,
      h: Math.max(...g.map((k) => k.h)),
      l: Math.min(...g.map((k) => k.l)),
      c: g[g.length - 1]!.c,
      v: g.reduce((a, k) => a + k.v, 0),
    });
  }
  return out;
}

function positiveOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const DAILY_EQUITY_MAX_AGE_MS = 4 * DAY_MS + 3_600_000;
