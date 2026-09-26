import type { Instrument } from '../../src/core/domain/market';
import { DAY_MS, utcDayStart } from '../../src/core/domain/time';
import { CandleService } from '../../src/server/data/candle-service';
import { FixtureProvider } from '../../src/server/data/fixture';
import {
  aggregateCandles,
  AlphaVantageProvider,
  CoinbaseProvider,
  parseAlphaVantageDaily,
  parseCoinbaseRow,
  parseKrakenRow,
} from '../../src/server/data/providers';
import { ProviderError } from '../../src/server/data/types';
import { getInstrument } from '../../src/server/db/core';
import { syntheticCandles } from '../helpers/candles';
import { TestD1 } from '../helpers/d1';
import { clock, FakeProvider } from '../helpers/server';

const btc: Instrument = {
  id: 'coinbase:BTC-USD',
  provider: 'coinbase',
  symbol: 'BTC-USD',
  displayName: 'Bitcoin',
  assetClass: 'crypto',
  quoteCurrency: 'USD',
  priceIncrement: 0.01,
  sizeIncrement: 1e-8,
  minNotional: 1,
  active: true,
};

describe('adaptateurs : formats des fournisseurs', () => {
  it('Coinbase : [time, low, high, open, close, volume]', () => {
    expect(parseCoinbaseRow([1_700_000_000, 9, 12, 10, 11, 5])).toEqual({ t: 1_700_000_000_000, o: 10, h: 12, l: 9, c: 11, v: 5 });
    expect(parseCoinbaseRow(['x'])).toBeNull();
  });

  it('Kraken : chaînes, volume en 7e position', () => {
    expect(parseKrakenRow([1_700_000_000, '10', '12', '9', '11', '10.5', '5', 42])).toEqual({ t: 1_700_000_000_000, o: 10, h: 12, l: 9, c: 11, v: 5 });
  });

  it('Alpha Vantage : série journalière, tri chronologique, bougie à 00:00 UTC', () => {
    const candles = parseAlphaVantageDaily({
      'Time Series (Daily)': {
        '2026-09-25': { '1. open': '768.78', '2. high': '772.28', '3. low': '766.29', '4. close': '771.35', '5. volume': '36666733' },
        '2026-09-24': { '1. open': '764.065', '2. high': '768.95', '3. low': '763.245', '4. close': '767.18', '5. volume': '43983659' },
      },
    });
    expect(candles.map((k) => k.t)).toEqual([Date.UTC(2026, 8, 24), Date.UTC(2026, 8, 25)]);
    expect(candles[1]!.c).toBe(771.35);
  });

  it('Alpha Vantage : les messages de quota (HTTP 200) deviennent des erreurs typées', () => {
    expect(() => parseAlphaVantageDaily({ Information: 'The outputsize=full parameter value is a premium feature' })).toThrow(ProviderError);
    try {
      parseAlphaVantageDaily({ Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 25 requests per day.' });
    } catch (err) {
      expect((err as ProviderError).kind).toBe('rate_limited');
    }
  });

  it('Alpha Vantage sans clé : non configuré, aucun appel réseau', async () => {
    let called = false;
    const p = new AlphaVantageProvider(async () => {
      called = true;
      return new Response('{}');
    }, null);
    await expect(p.fetchCandles({ ...btc, id: 'alphavantage:SPY', provider: 'alphavantage', symbol: 'SPY', assetClass: 'etf' }, '1d', 10)).rejects.toThrow(/absente/);
    expect(called).toBe(false);
  });

  it('Coinbase : pagination par 300 et en-tête User-Agent', async () => {
    const urls: string[] = [];
    let ua = '';
    const now = Date.now();
    const p = new CoinbaseProvider(async (url, init) => {
      urls.push(url);
      ua = new Headers(init?.headers).get('User-Agent') ?? '';
      const end = Date.parse(new URL(url).searchParams.get('end')!);
      const rows = Array.from({ length: 300 }, (_, i) => [Math.floor((end - (i + 1) * 3600_000) / 1000), 1, 2, 1.5, 1.6, 10]);
      return new Response(JSON.stringify(rows));
    });
    const candles = await p.fetchCandles(btc, '1h', 450);
    expect(urls).toHaveLength(2);
    expect(ua).toMatch(/Tr-e-V0r/);
    expect(candles.length).toBe(600);
    expect(candles[0]!.t).toBeLessThan(candles[candles.length - 1]!.t);
    expect(now).toBeGreaterThan(0);
  });

  it('agrège 1 h → 4 h sans jamais publier de groupe incomplet', () => {
    const hourly = syntheticCandles({ n: 10, tf: '1h', start: Date.UTC(2026, 0, 1) });
    const four = aggregateCandles(hourly, 3_600_000, 4 * 3_600_000);
    expect(four).toHaveLength(2);
    expect(four[0]!.o).toBe(hourly[0]!.o);
    expect(four[0]!.c).toBe(hourly[3]!.c);
    expect(four[0]!.h).toBe(Math.max(...hourly.slice(0, 4).map((k) => k.h)));
  });
});

describe('données de démonstration (historique réel enregistré)', () => {
  it('écarte la bougie en cours à l’enregistrement et recale la dernière sur hier', async () => {
    const now = Date.UTC(2027, 0, 15, 10);
    const p = new FixtureProvider(() => now);
    const candles = await p.fetchCandles(btc, '1d', 400);
    expect(candles).toHaveLength(400);
    expect(candles[candles.length - 1]!.t).toBe(utcDayStart(now) - DAY_MS);
    // Consecutive days, real prices (BTC traded above 10 000 USD over the period).
    expect(candles[1]!.t - candles[0]!.t).toBe(DAY_MS);
    expect(Math.min(...candles.map((k) => k.l))).toBeGreaterThan(10_000);
  });
});

describe('moteur de données (cache, bougies fermées, repli)', () => {
  const T0 = Date.UTC(2026, 8, 10, 12);

  async function setup() {
    const db = new TestD1().asD1();
    const instrument = (await getInstrument(db, 'coinbase:BTC-USD'))!;
    const c = clock(T0);
    const closed = syntheticCandles({ n: 120, start: utcDayStart(T0) - 120 * DAY_MS });
    const forming = { ...closed[closed.length - 1]!, t: utcDayStart(T0) };
    const primary = new FakeProvider('coinbase', { [instrument.id]: [...closed, forming] });
    const fallback = new FakeProvider('kraken', { [instrument.id]: closed });
    const service = new CandleService(db, [primary, fallback], c.now);
    return { db, instrument, c, closed, primary, fallback, service };
  }

  it('ne sert que des bougies fermées (la bougie du jour est écartée)', async () => {
    const { instrument, service, closed } = await setup();
    const r = await service.getClosedCandles(instrument, '1d', 300);
    expect(r.candles).toHaveLength(120);
    expect(r.candles[r.candles.length - 1]!.t).toBe(closed[closed.length - 1]!.t);
    expect(r.asOf).toBe(utcDayStart(T0));
    expect(r.fromCache).toBe(false);
  });

  it('met en cache et ne rappelle pas le fournisseur avant l’échéance', async () => {
    const { instrument, service, primary, c } = await setup();
    await service.getClosedCandles(instrument, '1d', 300);
    c.advance(10 * 60_000);
    const r = await service.getClosedCandles(instrument, '1d', 300);
    expect(primary.calls).toBe(1);
    expect(r.fromCache).toBe(true);
  });

  it('bascule sur le fournisseur de repli, puis sert le cache en le signalant', async () => {
    const { instrument, service, primary, fallback, c } = await setup();
    primary.failWith = new Error('HTTP 503');
    const r = await service.getClosedCandles(instrument, '1d', 300);
    expect(r.source).toBe('kraken');
    expect(r.warnings.join()).toMatch(/503/);
    fallback.failWith = new Error('réseau');
    c.advance(DAY_MS);
    const cached = await service.getClosedCandles(instrument, '1d', 300);
    expect(cached.fromCache).toBe(true);
    expect(cached.warnings.join()).toMatch(/données en cache/);
  });
});
