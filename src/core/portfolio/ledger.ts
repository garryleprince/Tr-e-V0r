import type { ClosedTrade, ExitReason, Fill, Mode, OpenPosition } from '../domain/trading';

/**
 * Cash and position accounting, as pure functions. Used by the paper desk and
 * the backtest, so both compute P&L identically.
 *
 * Fills are in the instrument's quote currency; cash and P&L are in the account
 * currency. `fx` converts the first into the second at the moment of the fill
 * (1 when both are the same). The cost basis is kept in the account currency,
 * so a trade's result includes the currency effect between entry and exit.
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
  fx = 1,
): LedgerState {
  assertFx(fx);
  const value = fill.price * fill.quantity * fx;
  const fee = fill.fee * fx;
  const prev = state.position;
  if (prev === null) {
    return {
      cash: state.cash - value - fee,
      position: {
        id: meta.id,
        instrumentId: meta.instrumentId,
        mode: meta.mode,
        quantity: fill.quantity,
        avgPrice: fill.price,
        entryValue: value,
        stopLoss: meta.stopLoss,
        takeProfit: meta.takeProfit,
        expiresAt: meta.expiresAt,
        openedAt: fill.ts,
        decisionId: meta.decisionId,
        entryFees: fee,
      },
    };
  }
  const quantity = prev.quantity + fill.quantity;
  return {
    cash: state.cash - value - fee,
    position: {
      ...prev,
      quantity,
      avgPrice: (prev.avgPrice * prev.quantity + fill.price * fill.quantity) / quantity,
      entryValue: prev.entryValue + value,
      // A reinforcement adopts the newest protective levels.
      stopLoss: meta.stopLoss ?? prev.stopLoss,
      takeProfit: meta.takeProfit ?? prev.takeProfit,
      expiresAt: meta.expiresAt ?? prev.expiresAt,
      entryFees: prev.entryFees + fee,
    },
  };
}

export function applySell(
  state: LedgerState,
  fill: Fill,
  reason: ExitReason,
  fx = 1,
): { state: LedgerState; trade: ClosedTrade } {
  assertFx(fx);
  const prev = state.position;
  if (prev === null || fill.quantity > prev.quantity + 1e-12) {
    throw new RangeError('vente supérieure à la position détenue');
  }
  const closedFraction = fill.quantity / prev.quantity;
  const basis = prev.entryValue * closedFraction;
  const entryFeesShare = prev.entryFees * closedFraction;
  const proceeds = fill.price * fill.quantity * fx - fill.fee * fx;
  const pnl = proceeds - basis - entryFeesShare;
  const remaining = prev.quantity - fill.quantity;
  const trade: ClosedTrade = {
    instrumentId: prev.instrumentId,
    quantity: fill.quantity,
    entryPrice: prev.avgPrice,
    exitPrice: fill.price,
    openedAt: prev.openedAt,
    closedAt: fill.ts,
    pnl,
    returnPct: basis > 0 ? pnl / basis : 0,
    exitReason: reason,
  };
  return {
    state: {
      cash: state.cash + proceeds,
      position:
        remaining <= 1e-12
          ? null
          : { ...prev, quantity: remaining, entryValue: prev.entryValue - basis, entryFees: prev.entryFees - entryFeesShare },
    },
    trade,
  };
}

/** Market value in the account currency. */
export function positionValue(position: OpenPosition | null, markPrice: number, fx = 1): number {
  return position ? position.quantity * markPrice * fx : 0;
}

/** Average conversion factor paid at entry; the fallback when no current rate is known. */
export function entryFx(position: OpenPosition): number {
  const quoteValue = position.avgPrice * position.quantity;
  return quoteValue > 0 ? position.entryValue / quoteValue : 1;
}

function assertFx(fx: number): void {
  if (!(fx > 0) || !Number.isFinite(fx)) throw new RangeError('taux de change invalide');
}
