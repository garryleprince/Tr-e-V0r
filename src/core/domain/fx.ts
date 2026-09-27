/**
 * Currencies and conversion.
 *
 * Prices, fills and fees stay in the instrument's quote currency (what the venue
 * quotes). Cash, equity, P&L and every risk limit expressed as a share of
 * capital live in the account currency. A conversion factor turns one into the
 * other: `accountAmount = quoteAmount × factor`.
 *
 * Pure: rates are passed in; fetching them is the server's job.
 */

export const ACCOUNT_CURRENCIES = ['EUR', 'USD'] as const;
export type AccountCurrency = (typeof ACCOUNT_CURRENCIES)[number];

/** Default account currency of a new simulated account (owner based in the euro area). */
export const DEFAULT_ACCOUNT_CURRENCY: AccountCurrency = 'EUR';

/** Rates keyed by pair, `EURUSD` = price of 1 EUR in USD. */
export type FxRates = Readonly<Record<string, number>>;

/** Pairs the app sources, and the instrument that carries each one's daily bars. */
export const FX_INSTRUMENTS: Readonly<Record<string, string>> = {
  EURUSD: 'alphavantage:EURUSD',
};

/**
 * Factor converting an amount in `from` into `to`, or null when no rate is
 * known — never a guess (a missing rate blocks openings; see the Risk Engine).
 */
export function fxFactor(from: string, to: string, rates: FxRates): number | null {
  if (from === to) return 1;
  const direct = rates[`${from}${to}`];
  if (direct !== undefined && direct > 0 && Number.isFinite(direct)) return direct;
  const inverse = rates[`${to}${from}`];
  if (inverse !== undefined && inverse > 0 && Number.isFinite(inverse)) return 1 / inverse;
  return null;
}
