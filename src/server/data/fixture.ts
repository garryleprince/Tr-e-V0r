import type { Candle, Instrument, Quote } from '../../core/domain/market';
import { DAY_MS, utcDayStart, type Timeframe } from '../../core/domain/time';
import btc from './fixtures/btc-usd-1d.json';
import eth from './fixtures/eth-usd-1d.json';
import eurusd from './fixtures/eurusd-1d.json';
import mcPar from './fixtures/mc-par-1d.json';
import spy from './fixtures/spy-1d.json';
import { ProviderError, type MarketDataProvider } from './types';

/**
 * RECORDED market data for offline development — never used in production
 * (`readConfig` refuses MARKET_DATA_MODE=fixture there, and the UI shows a red
 * banner whenever this provider is active).
 *
 * The files hold real daily history retrieved from Alpha Vantage on 2026-09-26
 * (BTC, ETH, SPY) and 2026-09-27 (LVMH on Euronext Paris, EUR/USD).
 * To exercise the "fresh data" paths, the series is shifted in time so that its
 * last CLOSED bar ends at the most recent UTC midnight. Prices and their order
 * are untouched; only the dates move. The bar that was still forming when the
 * data was recorded is dropped, exactly as live data would be.
 */

interface FixtureFile {
  readonly source: string;
  readonly retrievedAt: string;
  readonly rows: readonly (readonly number[])[];
}

const FILES: Record<string, FixtureFile> = {
  'BTC-USD': btc as FixtureFile,
  'ETH-USD': eth as FixtureFile,
  SPY: spy as FixtureFile,
  'MC.PAR': mcPar as FixtureFile,
  EURUSD: eurusd as FixtureFile,
};

export const FIXTURE_NOTICE =
  'Données de démonstration : historique réel enregistré les 26 et 27/09/2026 (Alpha Vantage), décalé dans le temps. Ne reflète pas le marché actuel.';

export class FixtureProvider implements MarketDataProvider {
  readonly id = 'fixture';
  readonly label = 'Données de démonstration';
  constructor(private readonly now: () => number) {}

  supports(instrument: Instrument, tf: Timeframe): boolean {
    return tf === '1d' && instrument.symbol in FILES;
  }

  async fetchCandles(instrument: Instrument, tf: Timeframe, limit: number): Promise<Candle[]> {
    const file = FILES[instrument.symbol];
    if (!file || tf !== '1d') throw new ProviderError(this.id, `${instrument.symbol} ${tf} absent des données de démonstration`, 'unsupported');
    const rows = file.rows.map(([t, o, h, l, c, v]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v: v! }));
    // Drop the bar that was still forming at recording time (recorded on its own day).
    const recordedDay = Date.parse(`${file.retrievedAt}T00:00:00Z`);
    const closed = rows.filter((k) => k.t < recordedDay);
    const last = closed[closed.length - 1];
    if (!last) return [];
    const target = utcDayStart(this.now()) - DAY_MS;
    const shift = target - last.t;
    return closed.slice(-limit).map((k) => ({ ...k, t: k.t + shift }));
  }

  async fetchQuote(instrument: Instrument): Promise<Quote | null> {
    const candles = await this.fetchCandles(instrument, '1d', 1);
    const last = candles[candles.length - 1];
    return last ? { bid: null, ask: null, last: last.c, ts: this.now() } : null;
  }
}
