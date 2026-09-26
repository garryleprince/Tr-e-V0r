import { ruleProposal } from '../../src/core/agents/rules';
import { runBacktest, type Strategy } from '../../src/core/backtest/engine';
import { computeMetrics, drawdown } from '../../src/core/backtest/metrics';
import { proposePlan, validatePlan } from '../../src/core/backtest/plan';
import type { Instrument } from '../../src/core/domain/market';
import { DAY_MS } from '../../src/core/domain/time';
import { applyBuy, applySell } from '../../src/core/portfolio/ledger';
import { computeSnapshot } from '../../src/core/quant/features';
import { planOrder } from '../../src/core/portfolio/manager';
import { DEFAULT_RISK_LIMITS } from '../../src/core/risk/limits';
import { evaluateBarriers, fillMarketOrder, type CostModel } from '../../src/core/sim/exchange';
import { syntheticCandles } from '../helpers/candles';

const instrument: Instrument = {
  id: 'coinbase:BTC-USD',
  provider: 'coinbase',
  symbol: 'BTC-USD',
  displayName: 'Bitcoin',
  assetClass: 'crypto',
  quoteCurrency: 'USD',
  priceIncrement: 0.01,
  sizeIncrement: 0.00001,
  minNotional: 1,
  active: true,
};
const costs: CostModel = { feeBps: 10, minFee: 0, slippageBps: 5 };

describe('simulateur de fills', () => {
  it('un achat paie l’ask + slippage, une vente reçoit le bid − slippage, frais inclus', () => {
    const b = fillMarketOrder('BUY', 2, { referencePrice: 100, bid: 99.9, ask: 100.1, ts: 1 }, costs);
    expect(b.price).toBeCloseTo(100.1 * 1.0005, 10);
    expect(b.fee).toBeCloseTo(b.price * 2 * 0.001, 10);
    const s = fillMarketOrder('SELL', 2, { referencePrice: 100, bid: null, ask: null, ts: 1 }, costs);
    expect(s.price).toBeCloseTo(100 * 0.9995, 10);
    expect(s.slippageBps).toBeCloseTo(5, 6);
  });
});

describe('triple barrière', () => {
  const pos = { stopLoss: 95, takeProfit: 110, expiresAt: null };
  const bar = (o: number, h: number, l: number, c: number, t = 0) => ({ t, o, h, l, c, v: 1 });

  it('stop et objectif dans la même bougie : le stop est réputé touché d’abord', () => {
    expect(evaluateBarriers(pos, [bar(100, 112, 94, 105)], DAY_MS)).toEqual({ reason: 'stop', price: 95, ts: 0 });
  });

  it('un gap sous le stop s’exécute à l’ouverture, pas au stop', () => {
    expect(evaluateBarriers(pos, [bar(90, 91, 88, 89)], DAY_MS)!.price).toBe(90);
  });

  it('objectif et horizon', () => {
    expect(evaluateBarriers(pos, [bar(100, 111, 99, 108)], DAY_MS)!.reason).toBe('target');
    const timed = { ...pos, expiresAt: DAY_MS };
    expect(evaluateBarriers(timed, [bar(100, 101, 99, 100.5)], DAY_MS)).toEqual({ reason: 'time', price: 100.5, ts: DAY_MS });
  });
});

describe('registre', () => {
  it('P&L net des frais d’entrée et de sortie, clôture partielle', () => {
    const meta = { id: 'p', instrumentId: 'x:X', mode: 'PAPER' as const, stopLoss: 90, takeProfit: null, expiresAt: null, decisionId: null };
    let st = applyBuy({ cash: 1000, position: null }, { price: 100, quantity: 4, fee: 0.4, slippageBps: 0, ts: 1 }, meta);
    expect(st.cash).toBeCloseTo(599.6, 10);
    const half = applySell(st, { price: 110, quantity: 2, fee: 0.22, slippageBps: 0, ts: 2 }, 'signal');
    expect(half.trade.pnl).toBeCloseTo(20 - 0.22 - 0.2, 10);
    expect(half.state.position!.quantity).toBe(2);
    st = half.state;
    const rest = applySell(st, { price: 90, quantity: 2, fee: 0.18, slippageBps: 0, ts: 3 }, 'stop');
    expect(rest.state.position).toBeNull();
    expect(rest.trade.pnl).toBeCloseTo(-20 - 0.18 - 0.2, 10);
    expect(() => applySell(rest.state, { price: 1, quantity: 1, fee: 0, slippageBps: 0, ts: 4 }, 'manual')).toThrow();
  });
});

describe('Portfolio Manager', () => {
  const base = ruleProposal(computeSnapshot(instrument.id, '1d', syntheticCandles({ n: 120, seed: 4 })), false);

  it('dimensionne à risque fixe : la perte au stop vaut le % de capital autorisé', () => {
    const plan = planOrder({
      proposal: { ...base, action: 'BUY', entryPrice: 100, stopLoss: 96, takeProfit: 110, horizonBars: 5 },
      instrument,
      timeframe: '1d',
      referencePrice: 100,
      asOf: 0,
      position: null,
      equity: 10_000,
      riskPct: 1,
      decisionId: 'd',
    });
    expect(plan.kind).toBe('order');
    if (plan.kind === 'order') {
      expect(plan.intent.quantity).toBeCloseTo(25, 10); // 100 $ / 4 $
      expect(plan.intent.expiresAt).toBe(5 * DAY_MS);
    }
  });

  it('HOLD et SELL sans position ne produisent aucun ordre', () => {
    const args = { instrument, timeframe: '1d' as const, referencePrice: 100, asOf: 0, position: null, equity: 1e4, riskPct: 1, decisionId: null };
    expect(planOrder({ ...args, proposal: { ...base, action: 'HOLD' } }).kind).toBe('none');
    expect(planOrder({ ...args, proposal: { ...base, action: 'SELL', entryPrice: 100 } }).kind).toBe('none');
  });
});

describe('plan de validation', () => {
  const start = Date.UTC(2020, 0, 1);
  const end = start + 1500 * DAY_MS;

  it('propose un plan valide TRAIN → VALIDATION → TEST → OOS avec embargo', () => {
    const plan = proposePlan(start, end, '1d', 200);
    expect(validatePlan(plan)).toEqual({ ok: true });
    expect(plan.segments.map((s) => s.name)).toEqual(['TRAIN', 'VALIDATION', 'TEST', 'OOS']);
  });

  it('refuse chevauchement, désordre et embargo insuffisant', () => {
    const plan = proposePlan(start, end, '1d', 10);
    const [a, b, c, d] = plan.segments;
    expect(validatePlan({ ...plan, segments: [a!, { ...b!, start: a!.end - DAY_MS }, c!, d!] }).ok).toBe(false);
    expect(validatePlan({ ...plan, segments: [b!, a!, c!, d!] }).ok).toBe(false);
    expect(validatePlan({ ...plan, embargoBars: 500 }).ok).toBe(false);
  });
});

describe('métriques', () => {
  it('rendement, drawdown et profit factor', () => {
    const curve = [100, 110, 99, 121].map((equity, i) => ({ t: i * DAY_MS, equity }));
    const m = computeMetrics(curve, [
      { instrumentId: 'x', quantity: 1, entryPrice: 1, exitPrice: 2, openedAt: 0, closedAt: 1, pnl: 30, returnPct: 0.3, exitReason: 'target' },
      { instrumentId: 'x', quantity: 1, entryPrice: 1, exitPrice: 0.9, openedAt: 0, closedAt: 1, pnl: -10, returnPct: -0.1, exitReason: 'stop' },
    ], 365);
    expect(m.totalReturn).toBeCloseTo(0.21, 10);
    expect(m.maxDrawdown).toBeCloseTo(0.1, 10);
    expect(m.profitFactor).toBe(3);
    expect(m.winRate).toBe(0.5);
    expect(m.expectancy).toBe(10);
  });

  it('valeurs non calculables = null (jamais inventées)', () => {
    const m = computeMetrics([{ t: 0, equity: 100 }], [], 365);
    expect(m.sharpe).toBeNull();
    expect(m.profitFactor).toBeNull();
    expect(m.winRate).toBeNull();
  });

  it('pas de ratio annualisé sur trop peu de données (le « Sharpe −130 » de 3 relevés)', () => {
    const few = [10_000, 9_990, 9_997].map((equity, i) => ({ t: i * 5_000, equity }));
    const m = computeMetrics(few, [], 35_040);
    expect(m.sharpe).toBeNull();
    expect(m.sortino).toBeNull();
    expect(m.volatility).toBeNull();
    expect(m.cagr).toBeNull();
    expect(m.totalReturn).toBeCloseTo(-0.0003, 10); // a plain return is still reported

    const enough = Array.from({ length: 60 }, (_, i) => ({ t: i * DAY_MS, equity: 100 * (1 + 0.001 * i + (i % 3 === 0 ? -0.002 : 0)) }));
    const m2 = computeMetrics(enough, [], 365);
    expect(m2.sharpe).not.toBeNull();
    expect(m2.cagr).not.toBeNull();
  });

  it('drawdown d’une courbe croissante nul', () => {
    expect(drawdown([1, 2, 3].map((equity, t) => ({ t, equity }))).maxDrawdown).toBe(0);
  });
});

describe('moteur de backtest', () => {
  const candles = syntheticCandles({ n: 700, seed: 11, drift: 0.002, vol: 0.02, volume: 10_000 });
  const baseConfig = {
    instrument,
    timeframe: '1d' as const,
    candles,
    tradeFrom: candles[250]!.t,
    tradeTo: candles[699]!.t + DAY_MS,
    initialCash: 10_000,
    costs,
    limits: { ...DEFAULT_RISK_LIMITS, minAvgDollarVolume: 0 },
  };

  it('la stratégie ne voit jamais la bougie suivante ; l’ordre s’exécute à l’ouverture suivante', () => {
    const seen: number[] = [];
    const spy: Strategy = {
      id: 'spy',
      decide: (view) => {
        seen.push(view.candles[view.candles.length - 1]!.t);
        return ruleProposal(view.snapshot, view.holding);
      },
    };
    const res = runBacktest({ ...baseConfig, strategy: spy });
    // Decisions happen on consecutive bars, each seeing exactly its own bar as the last one.
    for (let k = 1; k < seen.length; k++) expect(seen[k]! - seen[k - 1]!).toBe(DAY_MS);
    expect(res.trades.length).toBeGreaterThan(0);
    for (const t of res.trades) {
      const entryBar = candles.find((k) => k.t === t.openedAt)!;
      // Entry = that bar's open + 5 bps slippage (no quote in backtest).
      expect(t.entryPrice).toBeCloseTo(entryBar.o * 1.0005, 8);
    }
  });

  it('les limites de risque s’appliquent : jamais plus de 1 % du capital risqué par trade', () => {
    const res = runBacktest({ ...baseConfig, strategy: { id: 'rules', decide: (v) => ruleProposal(v.snapshot, v.holding) } });
    for (const t of res.trades.filter((x) => x.exitReason === 'stop')) {
      // Loss at the stop ≈ risk budget, plus slippage, fees and gaps.
      expect(t.pnl / 10_000).toBeGreaterThan(-0.03);
    }
    expect(res.metrics.trades).toBe(res.trades.length);
  });

  it('est déterministe', () => {
    const s: Strategy = { id: 'rules', decide: (v) => ruleProposal(v.snapshot, v.holding) };
    const a = runBacktest({ ...baseConfig, strategy: s });
    const b = runBacktest({ ...baseConfig, strategy: s });
    expect(a.metrics).toEqual(b.metrics);
  });
});
