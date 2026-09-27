import { recordVendorCall, vendorCallsToday } from '../db/core';
import type { RuntimeConfig } from '../env';
import { FixtureProvider } from './fixture';
import { EcbProvider, YahooProvider } from './free-sources';
import { AlphaVantageProvider, CoinbaseProvider, KrakenProvider } from './providers';
import { ProviderError, type FetchLike, type MarketDataProvider } from './types';

/**
 * Which providers are active. In fixture mode (local development only), the
 * recorded-data provider replaces every network vendor. Only Alpha Vantage needs
 * a key, and it is optional: without one it simply declines (not configured).
 */
export function buildProviders(config: RuntimeConfig, fetcher: FetchLike, now: () => number, db?: D1Database): MarketDataProvider[] {
  if (config.marketDataMode === 'fixture') return [new FixtureProvider(now)];
  // Order matters only after each instrument's preferred provider (CandleService):
  // crypto → Coinbase, Kraken; FX → ECB, then fallbacks; equities → Yahoo, then
  // Alpha Vantage when a key is configured.
  return [
    new CoinbaseProvider(fetcher),
    new KrakenProvider(fetcher),
    new EcbProvider(fetcher),
    new YahooProvider(fetcher),
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
