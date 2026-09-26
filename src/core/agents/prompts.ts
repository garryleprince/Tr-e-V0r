import type { AgentReport, Consensus } from '../domain/analysis';
import { AGENT_LABELS } from '../domain/analysis';
import { round, type TechnicalSnapshot } from '../quant/features';
import type { AnalysisContext } from './contracts';

/**
 * Prompts for the LLM-backed agents.
 *
 * System prompts are constant strings — no date, no id, no number — so that a
 * provider-side prompt cache can reuse them across calls. Everything that
 * varies goes into the user message, as JSON the model interprets but never
 * recomputes.
 */

export const TECHNICAL_SYSTEM_PROMPT = `Tu es l'analyste technique d'une équipe de trading. Tu reçois un instantané de données de marché calculé par un moteur quantitatif : c'est la seule source de vérité pour tout chiffre.

Ton rôle : interpréter la tendance, le momentum, la volatilité, les volumes, les supports et résistances, et en tirer une lecture directionnelle avec un niveau de confiance honnête.

Règles :
- Ne cite que des chiffres présents dans l'instantané. N'invente aucun niveau de prix, aucun indicateur, aucune date.
- Si une donnée vaut null ou figure dans "warnings", dis que l'information manque au lieu de la supposer.
- La confiance reflète la cohérence des signaux : des signaux contradictoires ou un historique court justifient une confiance faible.
- Tu n'es pas décisionnaire : d'autres agents décident du trade et un moteur de risque indépendant peut tout refuser.
- Réponds en français, de manière concise.`;

export const TRADER_SYSTEM_PROMPT = `Tu es le trader d'une équipe de trading. Tu reçois l'instantané quantitatif d'un actif, les rapports des analystes (certains peuvent être indisponibles), leur consensus et l'état du portefeuille. Tu proposes une action : BUY, SELL ou HOLD.

Cadre imposé :
- Positions longues uniquement. BUY ouvre ou renforce une position longue. SELL réduit ou clôture une position longue existante. SELL sans position détenue est interdit.
- Pour un BUY : un prix d'entrée proche du dernier cours (écart inférieur à 2 %), un stop-loss sous l'entrée et, si pertinent, un objectif au-dessus. Appuie ces niveaux sur l'ATR et les supports et résistances fournis.
- Tous les prix sont des prix absolus dans la devise de cotation, jamais des pourcentages.
- La quantité finale est calculée par le système à partir du risque autorisé ; ta suggestion de taille n'est qu'indicative.
- Un moteur de risque indépendant validera, réduira ou refusera ta proposition. Ne cherche pas à anticiper ou contourner ses limites.
- Un rapport indisponible est une absence d'information, pas un avis neutre.
- HOLD est une décision à part entière quand les signaux sont contradictoires ou insuffisants.

Donne un scénario principal et un scénario alternatif avec des probabilités cohérentes (somme au plus 1), les facteurs déterminants, ce qui invaliderait la thèse, et une justification concise en français.`;

/** Rounds every number so prompts stay compact and stable. */
export function compactSnapshot(s: TechnicalSnapshot): Record<string, unknown> {
  const r = (v: number | null, d = 6) => (v === null ? null : round(v, d));
  const price = (v: number | null) => (v === null ? null : significant(v, 8));
  return {
    instrumentId: s.instrumentId,
    timeframe: s.timeframe,
    asOf: new Date(s.asOf).toISOString(),
    barsUsed: s.barsUsed,
    lastClose: price(s.lastClose),
    change1Pct: r(s.change1 === null ? null : s.change1 * 100, 3),
    change20Pct: r(s.change20 === null ? null : s.change20 * 100, 3),
    sma20: price(s.sma20),
    sma50: price(s.sma50),
    sma200: price(s.sma200),
    macd: s.macd && {
      line: significant(s.macd.line, 6),
      signal: significant(s.macd.signal, 6),
      histogram: significant(s.macd.histogram, 6),
    },
    rsi14: r(s.rsi14, 2),
    atr14: price(s.atr14),
    atrPct: r(s.atrPct === null ? null : s.atrPct * 100, 3),
    bollinger: s.bollinger && {
      upper: price(s.bollinger.upper),
      middle: price(s.bollinger.middle),
      lower: price(s.bollinger.lower),
      bandwidthPct: r(s.bollinger.bandwidth * 100, 3),
    },
    realizedVol20AnnualisedPct: r(s.realizedVol20 === null ? null : s.realizedVol20 * 100, 2),
    volumeZScore20: r(s.volumeZ20, 2),
    avgDollarVolume20: r(s.avgDollarVolume20, 0),
    donchian20: s.donchian20 && { high: price(s.donchian20.high), low: price(s.donchian20.low) },
    supports: s.supports.map((l) => ({ price: price(l.price), touches: l.touches })),
    resistances: s.resistances.map((l) => ({ price: price(l.price), touches: l.touches })),
    trend: s.trend,
    trendSlopePctPerBar: r(s.trendSlope === null ? null : s.trendSlope * 100, 4),
    volatilityRegime: s.volatilityRegime,
    atrPercentile: r(s.atrPercentile, 3),
    technicalScore: s.technicalScore,
    scoreComponents: Object.fromEntries(
      Object.entries(s.scoreComponents).map(([k, v]) => [k, round(v, 3)]),
    ),
    warnings: s.warnings,
  };
}

export function technicalUserMessage(ctx: AnalysisContext): string {
  const recent = ctx.candles.slice(-10).map((k) => ({
    open: new Date(k.t).toISOString(),
    o: significant(k.o, 8),
    h: significant(k.h, 8),
    l: significant(k.l, 8),
    c: significant(k.c, 8),
    v: significant(k.v, 6),
  }));
  return JSON.stringify({
    instrument: identity(ctx),
    snapshot: compactSnapshot(ctx.snapshot),
    last10Candles: recent,
  });
}

export function traderUserMessage(
  ctx: AnalysisContext,
  reports: readonly AgentReport[],
  consensus: Consensus,
): string {
  return JSON.stringify({
    instrument: identity(ctx),
    snapshot: compactSnapshot(ctx.snapshot),
    analystReports: reports.map((r) => ({
      agent: AGENT_LABELS[r.agent],
      status: r.status,
      stance: r.stance,
      confidence: r.confidence,
      summary: r.status === 'ok' ? r.summary : r.unavailableReason ?? r.error ?? 'indisponible',
      details: r.status === 'ok' ? r.details : undefined,
    })),
    consensus,
    position: ctx.position
      ? {
          quantity: ctx.position.quantity,
          avgPrice: significant(ctx.position.avgPrice, 8),
          stopLoss: ctx.position.stopLoss,
          takeProfit: ctx.position.takeProfit,
        }
      : null,
    portfolio: {
      equity: round(ctx.portfolio.equity, 2),
      cash: round(ctx.portfolio.cash, 2),
      grossExposurePct:
        ctx.portfolio.equity > 0 ? round((ctx.portfolio.grossExposure / ctx.portfolio.equity) * 100, 2) : 0,
      openPositions: ctx.portfolio.openPositions.length,
    },
  });
}

function identity(ctx: AnalysisContext) {
  return {
    id: ctx.instrument.id,
    name: ctx.instrument.displayName,
    assetClass: ctx.instrument.assetClass,
    quoteCurrency: ctx.instrument.quoteCurrency,
  };
}

function significant(v: number, digits: number): number {
  if (v === 0 || !Number.isFinite(v)) return v;
  return Number(v.toPrecision(digits));
}
