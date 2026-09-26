import type { Candle, Instrument, Quote } from '../../core/domain/market';
import type { Timeframe } from '../../core/domain/time';

/**
 * Market data provider port. An adapter translates one vendor's API into these
 * types and nothing else: vendor quirks never leak past this boundary
 * (TradingAgents' layering rule, Nautilus' adapters).
 *
 * Adapters MAY return the bar that is still forming; the candle service drops
 * it. Adapters must not repair invalid rows.
 */
export interface MarketDataProvider {
  readonly id: string;
  readonly label: string;
  supports(instrument: Instrument, tf: Timeframe): boolean;
  /** Up to `limit` most recent candles, oldest first. */
  fetchCandles(instrument: Instrument, tf: Timeframe, limit: number, signal?: AbortSignal): Promise<Candle[]>;
  /** Best bid/ask, when the vendor offers one; null otherwise. */
  fetchQuote?(instrument: Instrument, signal?: AbortSignal): Promise<Quote | null>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly kind: 'network' | 'http' | 'rate_limited' | 'not_configured' | 'bad_payload' | 'unsupported',
  ) {
    super(`${provider} : ${message}`);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = 'Tr-e-V0r/0.1 (+https://github.com/garryleprince/Tr-e-V0r)';

export async function getJson(fetcher: FetchLike, provider: string, url: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetcher(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal });
  } catch (err) {
    throw new ProviderError(provider, `réseau : ${err instanceof Error ? err.message : String(err)}`, 'network');
  }
  if (res.status === 429) throw new ProviderError(provider, 'limite de requêtes atteinte', 'rate_limited');
  if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`, 'http');
  try {
    return await res.json();
  } catch {
    throw new ProviderError(provider, 'réponse illisible', 'bad_payload');
  }
}
