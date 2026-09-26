import type { Instrument } from '../../src/core/domain/market';
import type { OrderIntent } from '../../src/core/domain/trading';
import { evaluateIntent, floorTo, requiredStateFromHealth, type RiskState } from '../../src/core/risk/engine';
import { DEFAULT_RISK_LIMITS, looseningChanges, RiskLimitsSchema } from '../../src/core/risk/limits';

const instrument: Instrument = {
  id: 'coinbase:ETH-USD',
  provider: 'coinbase',
  symbol: 'ETH-USD',
  displayName: 'Ethereum',
  assetClass: 'crypto',
  quoteCurrency: 'USD',
  priceIncrement: 0.01,
  sizeIncrement: 0.0001,
  minNotional: 10,
  active: true,
};

const NOW = Date.UTC(2026, 8, 1, 12);

function state(over: Partial<RiskState> = {}): RiskState {
  return {
    now: NOW,
    mode: 'PAPER',
    tradingState: 'ACTIVE',
    limits: DEFAULT_RISK_LIMITS,
    equity: 10_000,
    cash: 10_000,
    peakEquity: 10_000,
    dayStartEquity: 10_000,
    positions: [],
    consecutiveLosses: 0,
    lastLossAt: null,
    newOrdersToday: 0,
    correlations: {},
    feeBps: 10,
    market: {
      instrument,
      referencePrice: 2000,
      dataAsOf: NOW - 60_000,
      maxDataAgeMs: 2 * 86_400_000,
      atr: 60,
      avgDollarVolume: 500_000_000,
      bid: 1999.5,
      ask: 2000.5,
    },
    ...over,
  };
}

function buy(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    instrumentId: instrument.id,
    side: 'BUY',
    quantity: 0.5,
    referencePrice: 2000,
    entryPrice: 2000,
    stopLoss: 1880, // 2 ATR
    takeProfit: 2180,
    expiresAt: null,
    confidence: 0.7,
    reduceOnly: false,
    origin: 'ai',
    decisionId: 'd1',
    reason: 'test',
    ...over,
  };
}

const failed = (r: ReturnType<typeof evaluateIntent>) =>
  r.verdict.checks.filter((c) => c.severity === 'block' && !c.passed).map((c) => c.rule);

describe('Risk Engine — ouvertures', () => {
  it('approuve un ordre conforme et produit un ApprovedOrder figé', () => {
    const r = evaluateIntent(buy(), state());
    expect(r.verdict.outcome).toBe('APPROVED');
    expect(r.order).not.toBeNull();
    expect(Object.isFrozen(r.order)).toBe(true);
    expect(r.order!.quantity).toBe(0.5);
  });

  it('réduit la quantité au risque par trade (1 % du capital au stop)', () => {
    // risk budget 100 $, 120 $ per unit → 0.8333 ; position cap 20 % → 1.0 ; requested 5
    const r = evaluateIntent(buy({ quantity: 5 }), state());
    expect(r.verdict.outcome).toBe('RESIZED');
    expect(r.order!.quantity).toBe(0.8333);
    const loss = (2000 - 1880) * r.order!.quantity;
    expect(loss).toBeLessThanOrEqual(100);
  });

  it('refuse sans stop-loss, ou avec un stop au-dessus de l’entrée', () => {
    expect(failed(evaluateIntent(buy({ stopLoss: null }), state()))).toContain('stop_required');
    expect(failed(evaluateIntent(buy({ stopLoss: 2010 }), state()))).toContain('stop_required');
  });

  it('refuse un stop trop serré (bruit) ou trop large', () => {
    expect(failed(evaluateIntent(buy({ stopLoss: 1990 }), state()))).toContain('stop_distance');
    expect(failed(evaluateIntent(buy({ stopLoss: 1000 }), state()))).toContain('stop_distance');
  });

  it('refuse une entrée éloignée du marché (bande de prix)', () => {
    expect(failed(evaluateIntent(buy({ entryPrice: 2100, stopLoss: 1980, takeProfit: 2300 }), state()))).toContain(
      'price_band',
    );
  });

  it('fail-closed : données périmées, ATR inconnu, liquidité inconnue', () => {
    const stale = state({ market: { ...state().market, dataAsOf: NOW - 5 * 86_400_000 } });
    expect(failed(evaluateIntent(buy(), stale))).toContain('data_freshness');
    const noAtr = state({ market: { ...state().market, atr: null } });
    expect(failed(evaluateIntent(buy(), noAtr))).toContain('volatility');
    const noVolume = state({ market: { ...state().market, avgDollarVolume: null } });
    expect(failed(evaluateIntent(buy(), noVolume))).toContain('liquidity');
  });

  it('refuse une volatilité excessive et une confiance insuffisante', () => {
    expect(failed(evaluateIntent(buy(), state({ market: { ...state().market, atr: 400 } })))).toContain('volatility');
    expect(failed(evaluateIntent(buy({ confidence: 0.4 }), state()))).toContain('confidence');
  });

  it('refuse un rapport gain/risque insuffisant', () => {
    expect(failed(evaluateIntent(buy({ takeProfit: 2050 }), state()))).toContain('reward_risk');
  });

  it('kill switch : REDUCING et HALTED bloquent toute ouverture', () => {
    expect(failed(evaluateIntent(buy(), state({ tradingState: 'REDUCING' })))).toContain('trading_state');
    expect(failed(evaluateIntent(buy(), state({ tradingState: 'HALTED' })))).toContain('trading_state');
  });

  it('drawdown maximal : refus et passage automatique en HALTED', () => {
    const r = evaluateIntent(buy(), state({ equity: 8400, cash: 8400, peakEquity: 10_000, dayStartEquity: 8400 }));
    expect(failed(r)).toContain('max_drawdown');
    expect(r.verdict.requiredTradingState).toBe('HALTED');
  });

  it('perte journalière : refus et passage automatique en REDUCING', () => {
    const r = evaluateIntent(buy(), state({ equity: 9650, cash: 9650, dayStartEquity: 10_000 }));
    expect(failed(r)).toContain('daily_loss');
    expect(r.verdict.requiredTradingState).toBe('REDUCING');
  });

  it('pertes consécutives : pause pendant le refroidissement, puis reprise', () => {
    const cooling = state({ consecutiveLosses: 3, lastLossAt: NOW - 3_600_000 });
    expect(failed(evaluateIntent(buy(), cooling))).toContain('consecutive_losses');
    const after = state({ consecutiveLosses: 3, lastLossAt: NOW - 25 * 3_600_000 });
    expect(failed(evaluateIntent(buy(), after))).not.toContain('consecutive_losses');
  });

  it('nombre de positions et d’ordres du jour', () => {
    const full = state({
      positions: [
        { instrumentId: 'a:A', quantity: 1, markPrice: 100 },
        { instrumentId: 'b:B', quantity: 1, markPrice: 100 },
        { instrumentId: 'c:C', quantity: 1, markPrice: 100 },
      ],
    });
    expect(failed(evaluateIntent(buy(), full))).toContain('max_positions');
    expect(failed(evaluateIntent(buy(), state({ newOrdersToday: 5 })))).toContain('orders_per_day');
  });

  it('corrélation élevée avec une position existante', () => {
    const s = state({
      positions: [{ instrumentId: 'coinbase:BTC-USD', quantity: 0.01, markPrice: 60_000 }],
      correlations: { 'coinbase:BTC-USD': 0.92 },
    });
    expect(failed(evaluateIntent(buy(), s))).toContain('correlation');
  });

  it('spread : refusé s’il est trop large ; non vérifiable = avertissement en simulation, refus en réel', () => {
    const wide = state({ market: { ...state().market, bid: 1980, ask: 2020 } });
    expect(failed(evaluateIntent(buy(), wide))).toContain('spread');
    const noQuote = state({ market: { ...state().market, bid: null, ask: null } });
    expect(failed(evaluateIntent(buy(), noQuote))).not.toContain('spread');
    expect(failed(evaluateIntent(buy(), { ...noQuote, mode: 'LIVE' }))).toContain('spread');
  });

  it('exposition totale et cash plafonnent la quantité', () => {
    const exposed = state({
      cash: 4500,
      positions: [{ instrumentId: 'a:A', quantity: 55, markPrice: 100 }], // 5 500 $ exposés
    });
    const r = evaluateIntent(buy({ quantity: 0.8 }), exposed);
    // remaining exposure budget: 6 000 − 5 500 = 500 $ → 0.25 ETH
    expect(r.order!.quantity).toBe(0.25);
  });

  it('refuse si la quantité tombe sous le minimum après les limites', () => {
    const r = evaluateIntent(buy(), state({ cash: 5 }));
    expect(r.verdict.outcome).toBe('REJECTED');
    expect(failed(r)).toContain('min_notional');
  });

  it('refuse une vente comme ouverture (pas de vente à découvert)', () => {
    expect(failed(evaluateIntent(buy({ side: 'SELL' }), state()))).toContain('long_only');
  });

  it('en mode recherche, le verdict reste calculé (indicatif)', () => {
    const r = evaluateIntent(buy(), state({ mode: 'RESEARCH' }));
    expect(r.verdict.outcome).toBe('APPROVED');
    expect(r.verdict.checks.find((c) => c.rule === 'mode')!.message).toMatch(/aucune exécution/);
  });
});

describe('Risk Engine — réductions (freins)', () => {
  const held = state({ positions: [{ instrumentId: instrument.id, quantity: 0.5, markPrice: 2000 }] });
  const sell = (over: Partial<OrderIntent> = {}) =>
    buy({ side: 'SELL', reduceOnly: true, stopLoss: null, takeProfit: null, ...over });

  it('une sortie de l’IA passe en REDUCING mais pas en HALTED', () => {
    expect(evaluateIntent(sell(), { ...held, tradingState: 'REDUCING' }).verdict.outcome).toBe('APPROVED');
    expect(evaluateIntent(sell(), { ...held, tradingState: 'HALTED' }).verdict.outcome).toBe('REJECTED');
  });

  it('stops et clôtures manuelles passent toujours, même en HALTED', () => {
    expect(evaluateIntent(sell({ origin: 'protective' }), { ...held, tradingState: 'HALTED' }).verdict.outcome).toBe('APPROVED');
    expect(evaluateIntent(sell({ origin: 'manual' }), { ...held, tradingState: 'HALTED' }).verdict.outcome).toBe('APPROVED');
  });

  it('les données manquantes ne bloquent jamais un frein', () => {
    const blind = { ...held, market: { ...held.market, dataAsOf: 0, atr: null, avgDollarVolume: null } };
    expect(evaluateIntent(sell(), blind).verdict.outcome).toBe('APPROVED');
  });

  it('ne vend jamais plus que la position (pas de vente à découvert)', () => {
    const r = evaluateIntent(sell({ quantity: 2 }), held);
    expect(r.verdict.outcome).toBe('RESIZED');
    expect(r.order!.quantity).toBe(0.5);
    expect(evaluateIntent(sell(), state()).verdict.outcome).toBe('REJECTED');
  });
});

describe('limites et plafonds', () => {
  it('les défauts respectent le schéma', () => {
    expect(RiskLimitsSchema.safeParse(DEFAULT_RISK_LIMITS).success).toBe(true);
  });

  it('aucun réglage ne peut dépasser les plafonds codés en dur (pas de levier)', () => {
    expect(RiskLimitsSchema.safeParse({ ...DEFAULT_RISK_LIMITS, maxGrossExposurePct: 150 }).success).toBe(false);
    expect(RiskLimitsSchema.safeParse({ ...DEFAULT_RISK_LIMITS, maxRiskPerTradePct: 10 }).success).toBe(false);
    expect(RiskLimitsSchema.safeParse({ ...DEFAULT_RISK_LIMITS, extra: 1 }).success).toBe(false);
  });

  it('détecte les desserrements (qui exigent une ré-authentification)', () => {
    const next = { ...DEFAULT_RISK_LIMITS, maxRiskPerTradePct: 2, minConfidence: 0.4, maxOpenPositions: 2 };
    expect(looseningChanges(DEFAULT_RISK_LIMITS, next).sort()).toEqual(['maxRiskPerTradePct', 'minConfidence']);
  });

  it('santé du compte', () => {
    expect(requiredStateFromHealth(DEFAULT_RISK_LIMITS, 8400, 10_000, 8400).state).toBe('HALTED');
    expect(requiredStateFromHealth(DEFAULT_RISK_LIMITS, 9650, 10_000, 10_000).state).toBe('REDUCING');
    expect(requiredStateFromHealth(DEFAULT_RISK_LIMITS, 9900, 10_000, 10_000).state).toBeNull();
  });

  it('arrondit toujours vers le bas au pas de quantité', () => {
    expect(floorTo(0.83339, 0.0001)).toBe(0.8333);
    expect(floorTo(0.3, 0.1)).toBe(0.3);
    expect(floorTo(-1, 0.1)).toBe(0);
  });
});
