import type { RuntimeConfig } from '../env';
import { FixtureProvider } from './fixture';
import { AlphaVantageProvider, CoinbaseProvider, KrakenProvider } from './providers';
import type { FetchLike, MarketDataProvider } from './types';

/**
 * Which providers are active. In fixture mode (local development only), the
 * recorded-data provider replaces every network vendor.
 */
export function buildProviders(config: RuntimeConfig, fetcher: FetchLike, now: () => number): MarketDataProvider[] {
  if (config.marketDataMode === 'fixture') return [new FixtureProvider(now)];
  return [
    new CoinbaseProvider(fetcher),
    new KrakenProvider(fetcher),
    new AlphaVantageProvider(fetcher, config.keys.alphaVantage),
  ];
}
