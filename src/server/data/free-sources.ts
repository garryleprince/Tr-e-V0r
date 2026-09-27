import type { Candle, Instrument } from '../../core/domain/market';
import { DAY_MS, type Timeframe } from '../../core/domain/time';
import { getJson, getText, ProviderError, type FetchLike, type MarketDataProvider } from './types';

/**
 * Sources that need no key.
 *
 * - European Central Bank: official euro reference rates, published around
 *   16:00 CET on TARGET2 business days (no weekend, no holiday rows). Open data,
 *   no registration. Used for the EUR/USD conversion.
 * - Yahoo Finance: UNOFFICIAL. Yahoo closed its public API in 2017; the `v8/chart`
 *   endpoint used here is internal, undocumented, and can change or be blocked at
 *   any time. Chosen by the owner (2026-09-27) to avoid any key for equities; the
 *   interface labels it as unofficial, and Alpha Vantage remains a fallback when a
 *   key is configured.
 *
 * Neither could be reached from the development sandbox: the parsers are tested
 * against the documented response formats, and the first deployment must confirm
 * them live (docs/LIMITES.md).
 */

// ----------------------------------------------------------------------- ECB

export class EcbProvider implements MarketDataProvider {
  readonly id = 'ecb';
  readonly label = 'Banque centrale européenne';
  constructor(
    private readonly fetcher: FetchLike,
    private readonly baseUrl = 'https://data-api.ecb.europa.eu',
  ) {}

  /** Pairs against the euro: `EURUSD`, `EURGBP`… (rate = units of the quote currency per euro). */
  supports(instrument: Instrument, tf: Timeframe): boolean {
    return instrument.assetClass === 'fx' && tf === '1d' && /^EUR[A-Z]{3}$/.test(instrument.symbol);
  }

  async fetchCandles(instrument: Instrument, tf: Timeframe, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    if (!this.supports(instrument, tf)) throw new ProviderError(this.id, `${instrument.symbol} ${tf} non pris en charge`, 'unsupported');
    const currency = instrument.symbol.slice(3);
    const url = `${this.baseUrl}/service/data/EXR/D.${currency}.EUR.SP00.A?lastNObservations=${Math.max(1, Math.min(limit, 500))}&detail=dataonly&format=csvdata`;
    const csv = await getText(this.fetcher, this.id, url, signal, { Accept: 'text/csv' });
    return parseEcbCsv(csv).slice(-limit);
  }
}

/**
 * SDMX CSV: one row per observation, columns located by name (TIME_PERIOD,
 * OBS_VALUE). A reference rate is a single daily fixing: open = high = low =
 * close, no volume.
 */
export function parseEcbCsv(csv: string): Candle[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0] ? splitCsvLine(lines[0]) : [];
  const iTime = header.indexOf('TIME_PERIOD');
  const iValue = header.indexOf('OBS_VALUE');
  if (iTime < 0 || iValue < 0) throw new ProviderError('ecb', 'colonnes TIME_PERIOD / OBS_VALUE absentes', 'bad_payload');
  const out: Candle[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const t = Date.parse(`${cells[iTime]}T00:00:00Z`);
    const v = Number(cells[iValue]);
    if (Number.isFinite(t) && Number.isFinite(v) && v > 0) out.push({ t, o: v, h: v, l: v, c: v, v: 0 });
  }
  if (out.length === 0) throw new ProviderError('ecb', 'aucune observation', 'bad_payload');
  return out.sort((a, b) => a.t - b.t);
}

/** RFC 4180 line splitter: quoted fields may contain commas and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// --------------------------------------------------------------------- Yahoo

/** Exchange suffixes: app convention (Alpha Vantage style) → Yahoo. */
const YAHOO_SUFFIX: Readonly<Record<string, string>> = { PAR: 'PA', DEX: 'DE', AMS: 'AS', LON: 'L', FRK: 'F' };

export function yahooSymbol(instrument: Pick<Instrument, 'symbol' | 'assetClass'>): string {
  if (instrument.assetClass === 'fx') return `${instrument.symbol}=X`;
  const m = /^(.+)\.([A-Z]{3})$/.exec(instrument.symbol);
  if (m) return `${m[1]}.${YAHOO_SUFFIX[m[2]!] ?? m[2]}`;
  return instrument.symbol;
}

/** Politeness: requests from this isolate are serialised and spaced. */
const YAHOO_MIN_SPACING_MS = 400;
let yahooQueue: Promise<unknown> = Promise.resolve();
let yahooLastCall = 0;

/** Identifies the app honestly while keeping the browser-compatible token the endpoint expects. */
const YAHOO_USER_AGENT = 'Mozilla/5.0 (compatible; Tr-e-V0r/0.2; +https://github.com/garryleprince/Tr-e-V0r)';

export class YahooProvider implements MarketDataProvider {
  readonly id = 'yahoo';
  readonly label = 'Yahoo Finance (source non officielle)';
  constructor(
    private readonly fetcher: FetchLike,
    private readonly opts: { baseUrl?: string; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  supports(instrument: Instrument, tf: Timeframe): boolean {
    return (instrument.assetClass === 'equity' || instrument.assetClass === 'etf' || instrument.assetClass === 'fx') && tf === '1d';
  }

  async fetchCandles(instrument: Instrument, tf: Timeframe, limit: number, signal?: AbortSignal): Promise<Candle[]> {
    if (!this.supports(instrument, tf)) throw new ProviderError(this.id, `${instrument.symbol} ${tf} non pris en charge`, 'unsupported');
    const base = this.opts.baseUrl ?? 'https://query1.finance.yahoo.com';
    // ~252 sessions a year: 2 years cover the 300 bars the engine asks for.
    const range = limit > 250 ? '2y' : '1y';
    const url = `${base}/v8/finance/chart/${encodeURIComponent(yahooSymbol(instrument))}?range=${range}&interval=1d&includePrePost=false`;
    const payload = await this.call(url, signal);
    return parseYahooChart(payload).slice(-limit);
  }

  private call(url: string, signal?: AbortSignal): Promise<unknown> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const run = async () => {
      const wait = yahooLastCall + YAHOO_MIN_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      yahooLastCall = Date.now();
      return getJson(this.fetcher, this.id, url, signal, { 'User-Agent': YAHOO_USER_AGENT });
    };
    const next = yahooQueue.then(run, run);
    yahooQueue = next.catch(() => undefined);
    return next;
  }
}

interface YahooChart {
  chart?: {
    result?: {
      meta?: { gmtoffset?: number; currency?: string };
      timestamp?: number[];
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
    }[] | null;
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * Daily bars from `v8/finance/chart`. Each timestamp is the session's opening
 * time; it is mapped to the session DATE at 00:00 UTC (the app's convention for
 * daily bars) using the exchange's UTC offset. Sessions open mid-morning, so a
 * daylight-saving hour can never move a bar to another date. Rows with a missing
 * value (holiday, halted session) are dropped, never filled.
 */
export function parseYahooChart(payload: unknown): Candle[] {
  const chart = (payload as YahooChart | null)?.chart;
  if (!chart) throw new ProviderError('yahoo', 'format de réponse inattendu', 'bad_payload');
  if (chart.error) throw new ProviderError('yahoo', chart.error.description ?? chart.error.code ?? 'erreur', 'http');
  const result = chart.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const ts = result?.timestamp;
  if (!result || !quote || !Array.isArray(ts)) throw new ProviderError('yahoo', 'série absente', 'bad_payload');
  const offsetMs = (result.meta?.gmtoffset ?? 0) * 1000;
  const byDay = new Map<number, Candle>();
  ts.forEach((sec, i) => {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i] ?? 0;
    if (![o, h, l, c].every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) return;
    const t = Math.floor((sec * 1000 + offsetMs) / DAY_MS) * DAY_MS;
    byDay.set(t, { t, o: o!, h: h!, l: l!, c: c!, v: typeof v === 'number' && Number.isFinite(v) ? v : 0 });
  });
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}
