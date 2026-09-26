/**
 * Worker bindings and configuration.
 *
 * Secrets arrive as environment bindings set with `wrangler secret put`; they
 * are read here and nowhere else, and never returned by any API route.
 */

export interface Env {
  readonly DB: D1Database;
  readonly DESK: DurableObjectNamespace;
  readonly ASSETS?: Fetcher;

  readonly ENVIRONMENT?: string;
  readonly LIVE_TRADING_ENABLED?: string;
  readonly KILL_SWITCH?: string;
  readonly MARKET_DATA_MODE?: string;

  // Secrets
  readonly SETUP_TOKEN?: string;
  readonly SESSION_PEPPER?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly OPENAI_COMPATIBLE_API_KEY?: string;
  readonly ALPHAVANTAGE_API_KEY?: string;
}

export interface RuntimeConfig {
  readonly production: boolean;
  /** Deployment-level emergency stop: forces HALTED whatever the stored state. */
  readonly killSwitchForced: boolean;
  /** Must be false in V0.1: no live venue exists. */
  readonly liveTradingEnabled: boolean;
  readonly marketDataMode: 'live' | 'fixture';
  readonly setupToken: string | null;
  readonly sessionPepper: string;
  readonly keys: {
    readonly anthropic: string | null;
    readonly openaiCompatible: string | null;
    readonly alphaVantage: string | null;
  };
}

export class ConfigError extends Error {}

export function readConfig(env: Env): RuntimeConfig {
  const production = (env.ENVIRONMENT ?? 'production') === 'production';
  const mode = env.MARKET_DATA_MODE === 'fixture' ? 'fixture' : 'live';
  if (production && mode === 'fixture') {
    // Recorded data must never be served as if it were the market.
    throw new ConfigError('MARKET_DATA_MODE=fixture est interdit en production');
  }
  const pepper = nonEmpty(env.SESSION_PEPPER);
  if (production && pepper === null) {
    throw new ConfigError('le secret SESSION_PEPPER est requis en production');
  }
  return {
    production,
    killSwitchForced: (env.KILL_SWITCH ?? '').trim().toLowerCase() === 'halt',
    liveTradingEnabled: env.LIVE_TRADING_ENABLED === 'true',
    marketDataMode: mode,
    setupToken: nonEmpty(env.SETUP_TOKEN),
    sessionPepper: pepper ?? 'dev-only-pepper',
    keys: {
      anthropic: nonEmpty(env.ANTHROPIC_API_KEY),
      openaiCompatible: nonEmpty(env.OPENAI_COMPATIBLE_API_KEY),
      alphaVantage: nonEmpty(env.ALPHAVANTAGE_API_KEY),
    },
  };
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}
