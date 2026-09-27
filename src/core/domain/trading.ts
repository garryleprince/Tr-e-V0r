import { z } from 'zod';

/**
 * Orders, positions, modes and the trading state.
 */

/** Autonomy level (docs/AGENTS_IA.md §5). Stored, logged, never inferred. */
export const ModeSchema = z.enum(['RESEARCH', 'PAPER', 'LIVE']);
export type Mode = z.infer<typeof ModeSchema>;

export { MODE_LABELS } from '../labels';

/**
 * Kill switch, after NautilusTrader's `TradingState`:
 * - ACTIVE: AI may open and reduce;
 * - REDUCING: AI may only reduce exposure;
 * - HALTED: no AI order at all. Protective exits of existing positions and
 *   explicit manual closes still go through — they are brakes, not bets.
 */
export const TradingStateSchema = z.enum(['ACTIVE', 'REDUCING', 'HALTED']);
export type TradingState = z.infer<typeof TradingStateSchema>;

export const OrderSideSchema = z.enum(['BUY', 'SELL']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

/** Why an order exists. Protective and manual orders are brakes. */
export type OrderOrigin = 'ai' | 'protective' | 'manual';

/**
 * What the Portfolio Manager asks the desk to do. Not yet an order: it has not
 * been through the Risk Engine.
 */
export interface OrderIntent {
  readonly instrumentId: string;
  readonly side: OrderSide;
  /** Requested quantity in base units, before risk resizing. */
  readonly quantity: number;
  /** Price the decision was made against (last closed bar or quote). */
  readonly referencePrice: number;
  /** Proposal's entry price; checked against the reference (price band). */
  readonly entryPrice: number;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  /** Absolute expiry of the position, ms UTC, from the proposal's horizon. */
  readonly expiresAt: number | null;
  readonly confidence: number;
  /** true when the order can only decrease exposure. */
  readonly reduceOnly: boolean;
  readonly origin: OrderOrigin;
  readonly decisionId: string | null;
  readonly reason: string;
}

export type OrderStatus = 'FILLED' | 'REJECTED' | 'CANCELLED' | 'PENDING';

export interface Fill {
  readonly price: number;
  readonly quantity: number;
  readonly fee: number;
  /** Slippage paid versus the reference price, in basis points (positive = worse). */
  readonly slippageBps: number;
  readonly ts: number;
}

export interface OpenPosition {
  readonly id: string;
  readonly instrumentId: string;
  readonly mode: Mode;
  readonly quantity: number;
  /** Average entry price, quote currency. */
  readonly avgPrice: number;
  /** Cost basis excluding fees, ACCOUNT currency (converted at each fill's rate). */
  readonly entryValue: number;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly expiresAt: number | null;
  readonly openedAt: number;
  readonly decisionId: string | null;
  /** Fees paid on entry, account currency; deducted from the trade's net result. */
  readonly entryFees: number;
}

export type ExitReason = 'stop' | 'target' | 'time' | 'signal' | 'manual' | 'risk';

export { EXIT_REASON_LABELS } from '../labels';

export interface ClosedTrade {
  readonly instrumentId: string;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly openedAt: number;
  readonly closedAt: number;
  /** Net of all fees, account currency (includes the currency effect). */
  readonly pnl: number;
  readonly returnPct: number;
  readonly exitReason: ExitReason;
}
