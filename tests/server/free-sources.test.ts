import type { Instrument } from '../../src/core/domain/market';
import { CandleService } from '../../src/server/data/candle-service';
import { EcbProvider, parseEcbCsv, parseYahooChart, splitCsvLine, YahooProvider, yahooSymbol } from '../../src/server/data/free-sources';
import { buildProviders } from '../../src/server/data/registry';
import { ProviderError } from '../../src/server/data/types';
import { getInstrument } from '../../src/server/db/core';
import { TestD1 } from '../helpers/d1';
import { DEV_CONFIG } from '../helpers/server';

/**
 * Sources without a key. Neither the ECB nor Yahoo is reachable from the
 * development sandbox: these tests pin our parsing to the documented formats
 * (ECB SDMX CSV; Yahoo v8/chart JSON). The first deployment confirms them live.
 */

const eurusd: Instrument = {
  id: 'alphavantage:EURUSD',
  provider: 'ecb',
  symbol: 'EURUSD',
  displayName: 'Euro / Dollar US',
  assetClass: 'fx',
  quoteCurrency: 'USD',
  priceIncrement: 0.00001,
  sizeIncrement: 1,
  minNotional: 0,
  active: true,
};

const lvmh: Instrument = { ...eurusd, id: 'alphavantage:MC.PAR', provider: 'yahoo', symbol: 'MC.PAR', displayName: 'LVMH', assetClass: 'equity', quoteCurrency: 'EUR' };

const ECB_CSV = [
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,TITLE_COMPL',
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-24,1.1379,"ECB reference exchange rate, US dollar/Euro, 2:15 pm (C.E.T.)"',
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-25,1.1391,"ECB reference exchange rate, US dollar/Euro, 2:15 pm (C.E.T.)"',
  '',
].join('\r\n');

describe('BCE : taux de référence officiels, sans clé', () => {
  it('lit le CSV SDMX par nom de colonne, champs entre guillemets compris', () => {
    const k = parseEcbCsv(ECB_CSV);
    expect(k).toHaveLength(2);
    expect(k[1]).toEqual({ t: Date.UTC(2026, 8, 25), o: 1.1391, h: 1.1391, l: 1.1391, c: 1.1391, v: 0 });
    expect(splitCsvLine('a,"b, c ""d""",e')).toEqual(['a', 'b, c "d"', 'e']);
  });

  it('refuse un format inattendu (jamais de taux inventé)', () => {
    expect(() => parseEcbCsv('foo,bar\n1,2')).toThrow(ProviderError);
    expect(() => parseEcbCsv('TIME_PERIOD,OBS_VALUE\n')).toThrow(/aucune observation/);
  });

  it('interroge la série EXR/D.USD.EUR.SP00.A en CSV, sans clé', async () => {
    const urls: string[] = [];
    const p = new EcbProvider(async (url) => {
      urls.push(url);
      return new Response(ECB_CSV);
    });
    expect(p.supports(eurusd, '1d')).toBe(true);
    expect(p.supports(eurusd, '1h')).toBe(false);
    const k = await p.fetchCandles(eurusd, '1d', 30);
    expect(k.at(-1)!.c).toBe(1.1391);
    expect(urls[0]).toContain('/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=30');
    expect(urls[0]).toContain('format=csvdata');
    expect(urls[0]).not.toMatch(/key|token/i);
  });
});

/** Shape of `v8/finance/chart` for MC.PA: sessions open 09:00 Paris (07:00 UTC in summer). */
function yahooPayload() {
  const day = (d: number) => Date.UTC(2026, 8, d, 7) / 1000;
  return {
    chart: {
      result: [
        {
          meta: { currency: 'EUR', symbol: 'MC.PA', exchangeName: 'PAR', gmtoffset: 7200, exchangeTimezoneName: 'Europe/Paris' },
          timestamp: [day(23), day(24), day(25), day(26)],
          indicators: {
            quote: [
              {
                open: [403.05, 398.1, 401.45, null],
                high: [409.2, 401.85, 401.8, null],
                low: [396.35, 395.65, 395.15, null],
                close: [396.9, 397.1, 396.85, null],
                volume: [634527, 667597, 508148, null],
              },
            ],
            adjclose: [{ adjclose: [396.9, 397.1, 396.85, null] }],
          },
        },
      ],
      error: null,
    },
  };
}

describe('Yahoo Finance : actions sans clé (source non officielle)', () => {
  it('convertit les symboles de place : Paris .PA, Xetra .DE, Amsterdam .AS, change =X', () => {
    expect(yahooSymbol({ symbol: 'MC.PAR', assetClass: 'equity' })).toBe('MC.PA');
    expect(yahooSymbol({ symbol: 'SAP.DEX', assetClass: 'equity' })).toBe('SAP.DE');
    expect(yahooSymbol({ symbol: 'ASML.AMS', assetClass: 'equity' })).toBe('ASML.AS');
    expect(yahooSymbol({ symbol: 'NVDA', assetClass: 'equity' })).toBe('NVDA');
    expect(yahooSymbol({ symbol: 'EURUSD', assetClass: 'fx' })).toBe('EURUSD=X');
  });

  it('bougies datées au jour de séance (00:00 UTC), valeurs manquantes écartées', () => {
    const k = parseYahooChart(yahooPayload());
    expect(k).toHaveLength(3); // the session with nulls is dropped, never filled
    expect(k[2]).toEqual({ t: Date.UTC(2026, 8, 25), o: 401.45, h: 401.8, l: 395.15, c: 396.85, v: 508148 });
  });

  it('une erreur Yahoo est remontée, jamais transformée en données', () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } })).toThrow(/delisted/);
    expect(() => parseYahooChart({ nothing: true })).toThrow(ProviderError);
  });

  it('appelle v8/finance/chart en quotidien, en s’identifiant', async () => {
    const calls: { url: string; ua: string }[] = [];
    const p = new YahooProvider(
      async (url, init) => {
        calls.push({ url, ua: new Headers(init?.headers).get('User-Agent') ?? '' });
        return new Response(JSON.stringify(yahooPayload()));
      },
      { sleep: async () => undefined },
    );
    const k = await p.fetchCandles(lvmh, '1d', 300);
    expect(k).toHaveLength(3);
    expect(calls[0]!.url).toContain('/v8/finance/chart/MC.PA?range=2y&interval=1d');
    expect(calls[0]!.ua).toMatch(/Tr-e-V0r/);
    expect(p.supports(lvmh, '1h')).toBe(false);
  });
});

describe('ordre des sources', () => {
  it('sans aucune clé : actions via Yahoo, change via la BCE ; Alpha Vantage ignoré', async () => {
    const t = new TestD1();
    const db = t.asD1();
    const mc = (await getInstrument(db, 'alphavantage:MC.PAR'))!;
    const fx = (await getInstrument(db, 'alphavantage:EURUSD'))!;
    expect(mc.provider).toBe('yahoo'); // migration 0004
    expect(fx.provider).toBe('ecb');
    const candles = new CandleService(db, buildProviders(DEV_CONFIG, async () => new Response('{}'), Date.now), Date.now);
    expect(candles.providersFor(mc, '1d').map((p) => p.id)).toEqual(['yahoo', 'alphavantage']);
    expect(candles.providersFor(fx, '1d')[0]!.id).toBe('ecb');
    const av = candles.providersFor(mc, '1d').find((p) => p.id === 'alphavantage')!;
    expect(av.available?.()).toBe(false); // no key: skipped silently
  });

  it('avec une clé Alpha Vantage : elle reste en secours derrière Yahoo', async () => {
    const t = new TestD1();
    const db = t.asD1();
    const mc = (await getInstrument(db, 'alphavantage:MC.PAR'))!;
    const config = { ...DEV_CONFIG, keys: { ...DEV_CONFIG.keys, alphaVantage: 'key' } };
    const candles = new CandleService(db, buildProviders(config, async () => new Response('{}'), Date.now), Date.now);
    const order = candles.providersFor(mc, '1d');
    expect(order.map((p) => p.id)).toEqual(['yahoo', 'alphavantage']);
    expect(order[1]!.available?.()).toBe(true);
  });
});
