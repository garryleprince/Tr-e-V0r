import { buildConsensus, unavailableReport } from '../../src/core/agents/consensus';
import type { AnalysisContext, AnalystAgent, TraderAgent } from '../../src/core/agents/contracts';
import { runAgentPipeline } from '../../src/core/agents/orchestrator';
import { RuleBasedTechnicalAnalyst, RuleBasedTrader, ruleProposal } from '../../src/core/agents/rules';
import { checkProposal } from '../../src/core/agents/sanity';
import { TradeProposalSchema, type AgentReport, type TradeProposal } from '../../src/core/domain/analysis';
import type { Instrument } from '../../src/core/domain/market';
import { computeSnapshot } from '../../src/core/quant/features';
import { syntheticCandles } from '../helpers/candles';

const instrument: Instrument = {
  id: 'coinbase:BTC-USD',
  provider: 'coinbase',
  symbol: 'BTC-USD',
  displayName: 'Bitcoin',
  assetClass: 'crypto',
  quoteCurrency: 'USD',
  priceIncrement: 0.01,
  sizeIncrement: 0.00000001,
  minNotional: 1,
  active: true,
};

function context(seed: number, drift: number): AnalysisContext {
  const candles = syntheticCandles({ n: 260, seed, drift, vol: 0.015 });
  const snapshot = computeSnapshot(instrument.id, '1d', candles);
  return {
    instrument,
    timeframe: '1d',
    asOf: snapshot.asOf,
    candles,
    snapshot,
    position: null,
    portfolio: { equity: 10_000, cash: 10_000, grossExposure: 0, openPositions: [] },
  };
}

describe('snapshot technique', () => {
  it('asOf est la clôture de la dernière bougie fournie', () => {
    const ctx = context(1, 0);
    const lastOpen = ctx.candles[ctx.candles.length - 1]!.t;
    expect(ctx.snapshot.asOf).toBe(lastOpen + 86_400_000);
  });

  it('signale l’absence de MM200 plutôt que de l’inventer', () => {
    const candles = syntheticCandles({ n: 80, seed: 2 });
    const s = computeSnapshot(instrument.id, '1d', candles);
    expect(s.sma200).toBeNull();
    expect(s.warnings.some((w) => w.includes('MM200'))).toBe(true);
  });

  it('refuse un historique trop court', () => {
    expect(() => computeSnapshot(instrument.id, '1d', syntheticCandles({ n: 10 }))).toThrow(RangeError);
  });

  it('une tendance forte produit un régime et un score cohérents', () => {
    const up = context(5, 0.01);
    const down = context(5, -0.01);
    expect(up.snapshot.trend).toBe('up');
    expect(up.snapshot.technicalScore).toBeGreaterThan(0.3);
    expect(down.snapshot.trend).toBe('down');
    expect(down.snapshot.technicalScore).toBeLessThan(-0.3);
  });
});

describe('agents à règles', () => {
  it('le trader à règles produit des propositions valides pour le schéma', () => {
    for (const drift of [-0.01, 0, 0.01]) {
      const ctx = context(9, drift);
      for (const holding of [false, true]) {
        const p = ruleProposal(ctx.snapshot, holding);
        expect(TradeProposalSchema.safeParse(p).success).toBe(true);
        expect(checkProposal(p, ctx.snapshot, holding)).toEqual({ ok: true });
      }
    }
  });

  it('achète en tendance haussière avec un stop à 2 ATR', () => {
    const ctx = context(5, 0.01);
    const p = ruleProposal(ctx.snapshot, false);
    if (ctx.snapshot.rsi14! < 70 && ctx.snapshot.volatilityRegime !== 'high') {
      expect(p.action).toBe('BUY');
      expect(p.stopLoss).toBeCloseTo(ctx.snapshot.lastClose - 2 * ctx.snapshot.atr14!, 6);
    } else {
      expect(p.action).toBe('HOLD');
    }
  });

  it('ne vend jamais sans position (pas de vente à découvert)', () => {
    const p = ruleProposal(context(5, -0.01).snapshot, false);
    expect(p.action).not.toBe('SELL');
  });
});

describe('contrôles de cohérence d’une proposition', () => {
  const ctx = context(1, 0);
  const ref = ctx.snapshot.lastClose;
  const base: TradeProposal = {
    ...ruleProposal(ctx.snapshot, false),
    action: 'BUY',
    entryPrice: ref,
    stopLoss: ref * 0.95,
    takeProfit: ref * 1.1,
  };

  it('accepte une proposition cohérente', () => {
    expect(checkProposal(base, ctx.snapshot, false).ok).toBe(true);
  });

  it('refuse une entrée éloignée du marché (niveau halluciné)', () => {
    const r = checkProposal({ ...base, entryPrice: ref * 1.3 }, ctx.snapshot, false);
    expect(r.ok).toBe(false);
  });

  it('refuse un BUY sans stop ou avec un stop au-dessus de l’entrée', () => {
    expect(checkProposal({ ...base, stopLoss: null }, ctx.snapshot, false).ok).toBe(false);
    expect(checkProposal({ ...base, stopLoss: ref * 1.01 }, ctx.snapshot, false).ok).toBe(false);
  });

  it('refuse un SELL sans position', () => {
    expect(checkProposal({ ...base, action: 'SELL' }, ctx.snapshot, false).ok).toBe(false);
  });
});

describe('consensus', () => {
  const ok = (agent: AgentReport['agent'], stance: 'bullish' | 'bearish' | 'neutral', confidence: number): AgentReport => ({
    agent,
    status: 'ok',
    stance,
    confidence,
    summary: '',
    details: {},
    source: 'rules',
  });

  it('les agents indisponibles ne comptent pas comme neutres', () => {
    const c = buildConsensus([
      ok('technical', 'bullish', 0.8),
      unavailableReport('fundamental', 'non connecté'),
      unavailableReport('sentiment', 'non connecté'),
    ]);
    expect(c.bullish).toBe(1);
    expect(c.neutral).toBe(0);
    expect(c.agreement).toBe(1);
    expect(c.missing).toEqual(['fundamental', 'sentiment', 'macro']);
  });

  it('pondère par la confiance', () => {
    const c = buildConsensus([ok('technical', 'bullish', 0.9), ok('macro', 'bearish', 0.3)]);
    expect(c.dominant).toBe('bullish');
    expect(c.bullish).toBeCloseTo(0.75, 4);
  });

  it('aucun avis disponible', () => {
    const c = buildConsensus([unavailableReport('technical', 'x')]);
    expect(c.dominant).toBeNull();
  });
});

describe('orchestrateur', () => {
  it('un analyste qui échoue n’interrompt pas le cycle', async () => {
    const broken: AnalystAgent = {
      id: 'sentiment',
      analyze: async () => {
        throw new Error('flux indisponible');
      },
    };
    const res = await runAgentPipeline(context(5, 0.01), [new RuleBasedTechnicalAnalyst(), broken], new RuleBasedTrader());
    expect(res.reports[1]!.status).toBe('error');
    expect(res.reports[1]!.error).toBe('flux indisponible');
    expect(res.proposal).not.toBeNull();
  });

  it('une proposition incohérente devient INVALIDE, jamais HOLD', async () => {
    const ctx = context(5, 0.01);
    const liar: TraderAgent = {
      source: 'llm',
      propose: async () => ({
        ok: true,
        source: 'llm',
        proposal: { ...ruleProposal(ctx.snapshot, false), action: 'BUY', entryPrice: ctx.snapshot.lastClose * 2, stopLoss: 1 },
      }),
    };
    const res = await runAgentPipeline(ctx, [new RuleBasedTechnicalAnalyst()], liar);
    expect(res.proposal).toBeNull();
    expect(res.invalidReasons.length).toBeGreaterThan(0);
  });

  it('une exception du trader est capturée', async () => {
    const thrower: TraderAgent = {
      source: 'llm',
      propose: async () => {
        throw new Error('réseau');
      },
    };
    const res = await runAgentPipeline(context(1, 0), [], thrower);
    expect(res.trader.ok).toBe(false);
    expect(res.invalidReasons).toEqual(['réseau']);
  });
});
