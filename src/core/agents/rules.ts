import type { AgentReport, Stance, TradeProposal } from '../domain/analysis';
import { clamp, round, type TechnicalSnapshot } from '../quant/features';
import type { AnalysisContext, AnalystAgent, TraderAgent, TraderInput, TraderOutcome } from './contracts';

/**
 * Deterministic agents.
 *
 * They exist for three reasons: the application must work without any LLM key;
 * they are the baseline an LLM must beat out of sample to be worth its cost; and
 * they are free and reproducible in a backtest. They are NOT a promising
 * strategy — trend following with an ATR stop is a textbook baseline.
 */

export const RULES = {
  /** Score above which the technical reading is bullish (below the negative, bearish). */
  stanceThreshold: 0.15,
  buyScore: 0.3,
  sellScore: -0.3,
  maxRsiForEntry: 70,
  stopAtr: 2,
  targetAtr: 3,
  horizonBars: 10,
} as const;

export function stanceFromScore(score: number): Stance {
  if (score >= RULES.stanceThreshold) return 'bullish';
  if (score <= -RULES.stanceThreshold) return 'bearish';
  return 'neutral';
}

export const TREND_LABELS = { up: 'haussière', down: 'baissière', range: 'sans tendance' } as const;
export const VOL_LABELS = { low: 'faible', normal: 'normale', high: 'élevée' } as const;

export class RuleBasedTechnicalAnalyst implements AnalystAgent {
  readonly id = 'technical' as const;

  async analyze(ctx: AnalysisContext): Promise<AgentReport> {
    const s = ctx.snapshot;
    const stance = stanceFromScore(s.technicalScore);
    const parts = [
      `Tendance ${TREND_LABELS[s.trend]}, volatilité ${VOL_LABELS[s.volatilityRegime]}.`,
      `Score technique ${formatSigned(s.technicalScore)} sur une échelle de −1 à +1.`,
    ];
    if (s.rsi14 !== null) parts.push(`RSI 14 à ${s.rsi14.toFixed(1)}.`);
    if (s.warnings.length > 0) parts.push(`Limites : ${s.warnings.join(' ; ')}.`);
    return {
      agent: 'technical',
      status: 'ok',
      stance,
      confidence: round(0.5 + Math.abs(s.technicalScore) / 2, 3),
      summary: parts.join(' '),
      details: {
        keyLevels: [
          ...s.supports.map((l) => ({ label: 'Support', price: l.price, kind: 'support' })),
          ...s.resistances.map((l) => ({ label: 'Résistance', price: l.price, kind: 'resistance' })),
        ],
        scoreComponents: s.scoreComponents,
      },
      source: 'rules',
    };
  }
}

export class RuleBasedTrader implements TraderAgent {
  readonly source = 'rules' as const;

  async propose({ ctx }: TraderInput): Promise<TraderOutcome> {
    return { ok: true, proposal: ruleProposal(ctx.snapshot, ctx.position !== null), source: 'rules' };
  }
}

/**
 * Trend following with an ATR stop (long only).
 * BUY  : up-trend, score ≥ 0.3, RSI < 70, volatility not in its top quintile.
 * SELL : a position is held and (down-trend or score ≤ −0.3).
 * HOLD : otherwise.
 */
export function ruleProposal(s: TechnicalSnapshot, holding: boolean): TradeProposal {
  const score = s.technicalScore;
  const atr = s.atr14 ?? s.lastClose * 0.02;
  const confidence = round(clamp(0.5 + Math.abs(score) / 2, 0, 1), 3);
  const factors = Object.entries(s.scoreComponents)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4)
    .map(([factor, value]) => ({
      factor: FACTOR_LABELS[factor] ?? factor,
      direction: stanceFromScore(value),
      weight: round(Math.abs(value), 3),
    }));

  const wantsBuy =
    !holding &&
    s.trend === 'up' &&
    score >= RULES.buyScore &&
    (s.rsi14 === null || s.rsi14 < RULES.maxRsiForEntry) &&
    s.volatilityRegime !== 'high';
  const wantsSell = holding && (s.trend === 'down' || score <= RULES.sellScore);

  if (wantsBuy) {
    const entry = s.lastClose;
    return {
      action: 'BUY',
      confidence,
      entryPrice: entry,
      stopLoss: round(entry - RULES.stopAtr * atr, 8),
      takeProfit: round(entry + RULES.targetAtr * atr, 8),
      horizonBars: RULES.horizonBars,
      sizePctOfEquity: null,
      mainScenario: {
        title: 'Poursuite de la tendance',
        description: `La tendance haussière se prolonge vers ${round(entry + RULES.targetAtr * atr, 2)} (3 ATR).`,
        probability: round(clamp(0.45 + score / 4, 0, 1), 2),
      },
      altScenario: {
        title: 'Retournement',
        description: `Le prix revient sous ${round(entry - RULES.stopAtr * atr, 2)} (2 ATR) et le stop coupe la position.`,
        probability: round(clamp(0.55 - score / 4, 0, 1), 2),
      },
      keyFactors: factors,
      invalidation: `Clôture sous le stop à ${round(entry - RULES.stopAtr * atr, 2)} ou passage en tendance baissière.`,
      rationale: `Règle de suivi de tendance : tendance haussière, score ${formatSigned(score)} ≥ ${RULES.buyScore}, RSI sous ${RULES.maxRsiForEntry}, volatilité hors extrêmes. Stop à ${RULES.stopAtr} ATR, objectif à ${RULES.targetAtr} ATR.`,
    };
  }

  if (wantsSell) {
    return {
      action: 'SELL',
      confidence,
      entryPrice: s.lastClose,
      stopLoss: null,
      takeProfit: null,
      horizonBars: null,
      sizePctOfEquity: null,
      mainScenario: {
        title: 'Dégradation',
        description: 'La structure technique se dégrade ; la position est clôturée.',
        probability: round(clamp(0.5 - score / 4, 0, 1), 2),
      },
      altScenario: {
        title: 'Faux signal',
        description: 'Le repli est temporaire et la tendance reprend.',
        probability: round(clamp(0.5 + score / 4, 0, 1), 2),
      },
      keyFactors: factors,
      invalidation: 'Reprise au-dessus de la moyenne mobile 50 avec une pente positive.',
      rationale: `Règle de sortie : ${s.trend === 'down' ? 'tendance baissière' : `score ${formatSigned(score)} ≤ ${RULES.sellScore}`}.`,
    };
  }

  return {
    action: 'HOLD',
    confidence,
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    horizonBars: null,
    sizePctOfEquity: null,
    mainScenario: {
      title: holding ? 'Maintien de la position' : 'Attente',
      description: holding
        ? 'Les conditions de sortie ne sont pas réunies.'
        : 'Les conditions d’entrée ne sont pas réunies.',
      probability: 0.5,
    },
    altScenario: {
      title: 'Changement de régime',
      description: 'Un changement de tendance déclencherait un nouveau signal.',
      probability: 0.5,
    },
    keyFactors: factors,
    invalidation: 'Un signal d’entrée ou de sortie de la règle.',
    rationale: `Aucune condition remplie (tendance ${TREND_LABELS[s.trend]}, score ${formatSigned(score)}).`,
  };
}

const FACTOR_LABELS: Record<string, string> = {
  prix_vs_mm50: 'Prix vs moyenne mobile 50',
  prix_vs_mm200: 'Prix vs moyenne mobile 200',
  pente_mm50: 'Pente de la moyenne mobile 50',
  macd: 'Histogramme MACD',
  rsi: 'RSI 14',
  momentum_20: 'Momentum 20 bougies',
};

function formatSigned(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}
