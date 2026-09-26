import type { TradeProposal } from '../domain/analysis';
import type { Instrument } from '../domain/market';
import { TIMEFRAME_MS, type Timeframe } from '../domain/time';
import type { OpenPosition, OrderIntent } from '../domain/trading';

/**
 * Portfolio Manager.
 *
 * Deterministic translation of a trader's proposal into an order intent. The
 * proposal says WHAT and WHERE (direction, entry, stop, target, horizon); this
 * code decides HOW MUCH, from the risk budget — the language model never sets a
 * final quantity (FinRL-X's target-exposure contract, Nautilus' fixed-risk sizing).
 *
 * The quantity computed here is a *request*; the Risk Engine can only reduce it.
 */

/** Pluggable sizing (docs/ARCHITECTURE.md §5). A learned policy would implement this. */
export interface SizingPolicy {
  readonly id: string;
  /** Quantity for a new long position, before risk limits. */
  size(input: { equity: number; entry: number; stop: number; riskPct: number; proposal: TradeProposal }): number;
}

/**
 * Fixed-fractional sizing: the loss at the stop equals `riskPct` of equity.
 * The proposal's own size suggestion can only lower the result.
 */
export const fixedFractionalSizing: SizingPolicy = {
  id: 'fixed-fractional',
  size({ equity, entry, stop, riskPct, proposal }) {
    const perUnitRisk = entry - stop;
    if (!(perUnitRisk > 0) || !(equity > 0)) return 0;
    let qty = (equity * (riskPct / 100)) / perUnitRisk;
    if (proposal.sizePctOfEquity !== null && proposal.sizePctOfEquity > 0) {
      qty = Math.min(qty, (equity * (proposal.sizePctOfEquity / 100)) / entry);
    }
    return qty;
  },
};

export interface PlanInput {
  readonly proposal: TradeProposal;
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  readonly referencePrice: number;
  readonly asOf: number;
  readonly position: OpenPosition | null;
  readonly equity: number;
  readonly riskPct: number;
  readonly decisionId: string | null;
  readonly sizing?: SizingPolicy;
}

export type Plan =
  | { readonly kind: 'order'; readonly intent: OrderIntent; readonly explanation: string }
  | { readonly kind: 'none'; readonly explanation: string };

export function planOrder(input: PlanInput): Plan {
  const { proposal: p, instrument, referencePrice, position } = input;
  const sizing = input.sizing ?? fixedFractionalSizing;

  if (p.action === 'HOLD') {
    return { kind: 'none', explanation: 'HOLD : aucun ordre' };
  }

  if (p.action === 'SELL') {
    if (!position || position.quantity <= 0) {
      return { kind: 'none', explanation: 'SELL sans position : rien à réduire (pas de vente à découvert)' };
    }
    return {
      kind: 'order',
      explanation: `Clôture de la position (${position.quantity})`,
      intent: {
        instrumentId: instrument.id,
        side: 'SELL',
        quantity: position.quantity,
        referencePrice,
        entryPrice: p.entryPrice ?? referencePrice,
        stopLoss: null,
        takeProfit: null,
        expiresAt: null,
        confidence: p.confidence,
        reduceOnly: true,
        origin: 'ai',
        decisionId: input.decisionId,
        reason: 'Décision de sortie de l’IA',
      },
    };
  }

  // BUY
  const entry = p.entryPrice ?? referencePrice;
  if (p.stopLoss === null || p.stopLoss >= entry) {
    // The Risk Engine would refuse it anyway; say so here for a clear journal.
    return { kind: 'none', explanation: 'BUY sans stop-loss valide : aucun ordre' };
  }
  const quantity = sizing.size({
    equity: input.equity,
    entry,
    stop: p.stopLoss,
    riskPct: input.riskPct,
    proposal: p,
  });
  const expiresAt =
    p.horizonBars === null ? null : input.asOf + p.horizonBars * TIMEFRAME_MS[input.timeframe];
  return {
    kind: 'order',
    explanation: `Taille calculée par « ${sizing.id} » : ${input.riskPct} % du capital risqué au stop`,
    intent: {
      instrumentId: instrument.id,
      side: 'BUY',
      quantity,
      referencePrice,
      entryPrice: entry,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      expiresAt,
      confidence: p.confidence,
      reduceOnly: false,
      origin: 'ai',
      decisionId: input.decisionId,
      reason: position ? 'Renforcement de la position' : 'Ouverture de position',
    },
  };
}
