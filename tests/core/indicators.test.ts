import {
  atr,
  bollinger,
  donchian,
  ema,
  macd,
  pearson,
  roc,
  rsi,
  sma,
  swingLevels,
  trueRange,
} from '../../src/core/quant/indicators';
import { candlesFromCloses, syntheticCandles } from '../helpers/candles';

describe('moyennes mobiles', () => {
  it('SMA : valeurs connues et NaN avant la période', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out.slice(2)).toEqual([2, 3, 4]);
  });

  it('EMA : amorcée par la SMA puis lissée avec alpha = 2/(n+1)', () => {
    const out = ema([2, 4, 6, 8, 10], 3);
    // seed = mean(2,4,6) = 4 ; alpha = 0.5 ; 0.5*8 + 0.5*4 = 6 ; 0.5*10 + 0.5*6 = 8
    expect(out[2]).toBe(4);
    expect(out[3]).toBe(6);
    expect(out[4]).toBe(8);
  });

  it('EMA : s’enchaîne sur une série qui commence par des NaN', () => {
    const out = ema([Number.NaN, Number.NaN, 1, 2, 3, 4], 2);
    expect(Number.isNaN(out[2]!)).toBe(true);
    expect(out[3]).toBe(1.5);
  });
});

describe('RSI de Wilder', () => {
  // Classic worked example (Wilder's method). Published tables show 70.53 then
  // 66.32 because they round the intermediate averages. Exact arithmetic:
  // gains over the first 14 changes = 3.34, losses = 1.40
  // → avgGain 0.238571, avgLoss 0.1, RS 2.385714, RSI 70.464.
  // Next change −0.28 → avgGain 0.221531, avgLoss 0.112857, RSI 66.2496.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
    46.28, 46.0,
  ];

  it('reproduit l’exemple de référence', () => {
    const out = rsi(closes, 14);
    expect(Number.isNaN(out[13]!)).toBe(true);
    expect(out[14]).toBeCloseTo(70.464, 3);
    expect(out[15]).toBeCloseTo(66.2496, 3);
  });

  it('vaut 100 sur une série strictement croissante et 50 sur une série constante', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100);
    expect(rsi([5, 5, 5, 5, 5], 3)[4]).toBe(50);
  });
});

describe('ATR et true range', () => {
  it('le true range tient compte de la clôture précédente (gap)', () => {
    const tr = trueRange([
      { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
      { t: 1, o: 14, h: 15, l: 13.5, c: 14, v: 1 },
    ]);
    expect(tr[0]).toBe(2);
    expect(tr[1]).toBe(5); // |15 - 10|
  });

  it('ATR constant sur des barres identiques', () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1 }));
    const out = atr(candles, 14);
    expect(Number.isNaN(out[13]!)).toBe(true);
    expect(out[14]).toBe(2);
    expect(out[19]).toBe(2);
  });
});

describe('MACD, Bollinger, ROC, Donchian', () => {
  it('MACD nul sur une série constante', () => {
    const m = macd(new Array(60).fill(50));
    expect(m.line[59]).toBe(0);
    expect(m.signal[59]).toBe(0);
    expect(m.histogram[59]).toBe(0);
  });

  it('Bollinger : bandes confondues sur une série constante', () => {
    const b = bollinger(new Array(25).fill(10), 20, 2);
    expect(b.upper[24]).toBe(10);
    expect(b.lower[24]).toBe(10);
    expect(b.bandwidth[24]).toBe(0);
  });

  it('ROC', () => {
    expect(roc([100, 110, 121], 1)[2]).toBeCloseTo(0.1, 12);
    expect(roc([100, 110, 121], 2)[2]).toBeCloseTo(0.21, 12);
  });

  it('Donchian', () => {
    const d = donchian(candlesFromCloses([1, 5, 3, 2]), 3);
    expect(d.high[3]).toBeCloseTo(5 * 1.001, 9);
  });
});

describe('corrélation', () => {
  it('parfaite, opposée, indéfinie', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
});

describe('absence de look-ahead', () => {
  it('ajouter des barres futures ne modifie aucune valeur passée', () => {
    const all = syntheticCandles({ n: 300, seed: 7 });
    const past = all.slice(0, 200);
    const closesAll = all.map((k) => k.c);
    const closesPast = past.map((k) => k.c);
    const pairs: [number[], number[]][] = [
      [sma(closesPast, 50), sma(closesAll, 50)],
      [ema(closesPast, 26), ema(closesAll, 26)],
      [rsi(closesPast, 14), rsi(closesAll, 14)],
      [atr(past, 14), atr(all, 14)],
      [macd(closesPast).histogram, macd(closesAll).histogram],
    ];
    for (const [p, a] of pairs) {
      for (let i = 0; i < 200; i++) {
        if (Number.isNaN(p[i]!)) expect(Number.isNaN(a[i]!)).toBe(true);
        else expect(a[i]).toBe(p[i]);
      }
    }
  });

  it('les niveaux de swing ignorent les k dernières barres (non confirmées)', () => {
    const base = syntheticCandles({ n: 100, seed: 3 });
    // A spectacular high on the very last bar must not become a resistance.
    const last = base[base.length - 1]!;
    base[base.length - 1] = { ...last, h: last.h * 3 };
    const { resistances } = swingLevels(base, last.c, last.c * 0.005, 3);
    expect(resistances.every((r) => r.price < last.h * 2)).toBe(true);
  });
});
