import type { ClosedTrade, ExitReason, Fill, Mode, OpenPosition } from '../domain/trading';

/**
 * Cash and position accounting, as pure functions. Used by the paper desk and
 * the backtest, so both compute P&L identically.
 */

export interface LedgerState {
  readonly cash: number;
  readonly position: OpenPosition | null;
}

export function applyBuy(
  state: LedgerState,
  fill: Fill,
  meta: {
    id: string;
    instrumentId: string;
    mode: Mode;
    stopLoss: number | null;
    takeProfit: number | null;
    expiresAt: number | null;
    decisionId: string | null;
  },
): LedgerState {
  const cost = fill.price * fill.quantity + fill.fee;
  const prev = state.position;
  if (prev === null) {
    return {
      cash: state.cash - cost,
      position: {
        id: meta.id,
        instrumentId: meta.instrumentId,
        mode: meta.mode,
        quantity: fill.quantity,
        avgPrice: fill.price,
        stopLoss: meta.stopLoss,
        takeProfit: meta.takeProfit,
        expiresAt: meta.expiresAt,
        openedAt: fill.ts,
        decisionId: meta.decisionId,
        entryFees: fill.fee,
      },
    };
  }
  const quantity = prev.quantity + fill.quantity;
  return {
    cash: state.cash - cost,
    position: {
      ...prev,
      quantity,
      avgPrice: (prev.avgPrice * prev.quantity + fill.price * fill.quantity) / quantity,
      // A reinforcement adopts the newest protective levels.
      stopLoss: meta.stopLoss ?? prev.stopLoss,
      takeProfit: meta.takeProfit ?? prev.takeProfit,
      expiresAt: meta.expiresAt ?? prev.expiresAt,
      entryFees: prev.entryFees + fill.fee,
    },
  };
}

export function applySell(
  state: LedgerState,
  fill: Fill,
  reason: ExitReason,
): { state: LedgerState; trade: ClosedTrade } {
  const prev = state.position;
  if (prev === null || fill.quantity > prev.quantity + 1e-12) {
    throw new RangeError('vente supérieure à la position détenue');
  }
  const closedFraction = fill.quantity / prev.quantity;
  const entryFeesShare = prev.entryFees * closedFraction;
  const pnl = (fill.price - prev.avgPrice) * fill.quantity - fill.fee - entryFeesShare;
  const remaining = prev.quantity - fill.quantity;
  const trade: ClosedTrade = {
    instrumentId: prev.instrumentId,
    quantity: fill.quantity,
    entryPrice: prev.avgPrice,
    exitPrice: fill.price,
    openedAt: prev.openedAt,
    closedAt: fill.ts,
    pnl,
    returnPct: pnl / (prev.avgPrice * fill.quantity),
    exitReason: reason,
  };
  return {
    state: {
      cash: state.cash + fill.price * fill.quantity - fill.fee,
      position:
        remaining <= 1e-12 ? null : { ...prev, quantity: remaining, entryFees: prev.entryFees - entryFeesShare },
    },
    trade,
  };
}

export function positionValue(position: OpenPosition | null, markPrice: number): number {
  return position ? position.quantity * markPrice : 0;
}
