import { recordVendorCall, vendorCallsToday } from '../db/core';
import type { RuntimeConfig } from '../env';
import { FixtureProvider } from './fixture';
import { AlphaVantageProvider, CoinbaseProvider, KrakenProvider } from './providers';
import { ProviderError, type FetchLike, type MarketDataProvider } from './types';

/**
 * Which providers are active. In fixture mode (local development only), the
 * recorded-data provider replaces every network vendor.
 */
export function buildProviders(config: RuntimeConfig, fetcher: FetchLike, now: () => number, db?: D1Database): MarketDataProvider[] {
  if (config.marketDataMode === 'fixture') return [new FixtureProvider(now)];
  return [
    new CoinbaseProvider(fetcher),
    new KrakenProvider(fetcher),
    new AlphaVantageProvider(fetcher, config.keys.alphaVantage, {
      // The daily quota is shared by every request and cron run: counted in D1.
      ...(db
        ? {
            beforeCall: async () => {
              const used = await vendorCallsToday(db, 'alphavantage', now());
              if (used >= config.alphaVantageDailyLimit) {
                throw new ProviderError('alphavantage', `quota du jour atteint (${used}/${config.alphaVantageDailyLimit} appels) : données en cache`, 'rate_limited');
              }
              await recordVendorCall(db, 'alphavantage', now());
            },
          }
        : {}),
    }),
  ];
}
