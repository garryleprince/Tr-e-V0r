import type { Candle } from '../domain/market';
import type { ExitReason, Fill, OpenPosition } from '../domain/trading';

/**
 * Simulated exchange, shared by paper trading and backtesting so that a
 * strategy meets exactly the same fill rules in both (NautilusTrader's parity
 * principle). Market orders only in V0.1.
 */

export interface CostModel {
  /** Proportional fee on traded value, in basis points. */
  readonly feeBps: number;
  /** Minimum fee per fill, quote currency. */
  readonly minFee: number;
  /** Adverse price move applied to every market fill, in basis points. */
  readonly slippageBps: number;
}

/**
 * Defaults are deliberately pessimistic for a retail crypto account (taker fees
 * of major venues range from 10 to 60 bps). They are settings, not facts.
 */
export const DEFAULT_COSTS: CostModel = { feeBps: 10, minFee: 0, slippageBps: 5 };

export interface FillContext {
  /** Last price the decision was made against. */
  readonly referencePrice: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly ts: number;
}

/**
 * Fills a market order. A buy pays the ask (or the reference price when no
 * quote exists) plus slippage; a sell receives the bid minus slippage.
 */
export function fillMarketOrder(side: 'BUY' | 'SELL', quantity: number, ctx: FillContext, costs: CostModel): Fill {
  if (!(quantity > 0)) throw new RangeError('quantité nulle');
  const base = side === 'BUY' ? (ctx.ask ?? ctx.referencePrice) : (ctx.bid ?? ctx.referencePrice);
  const slip = costs.slippageBps / 10_000;
  const price = side === 'BUY' ? base * (1 + slip) : base * (1 - slip);
  const fee = Math.max(costs.minFee, price * quantity * (costs.feeBps / 10_000));
  const slippageBps = ((side === 'BUY' ? price - ctx.referencePrice : ctx.referencePrice - price) / ctx.referencePrice) * 10_000;
  return { price, quantity, fee, slippageBps, ts: ctx.ts };
}

export interface BarrierExit {
  readonly reason: Extract<ExitReason, 'stop' | 'target' | 'time'>;
  /** Price before slippage. */
  readonly price: number;
  readonly ts: number;
}

/**
 * Triple barrier (Hummingbot): stop-loss, take-profit and time limit, checked
 * bar by bar on bars that CLOSED after the position was opened.
 *
 * Conventions, all pessimistic and documented (docs/BACKTESTING.md):
 * - a bar that opens beyond a barrier (gap) fills at its open, not at the barrier;
 * - when a bar touches both the stop and the target, the stop is assumed to have
 *   been hit first — a bar does not tell which extreme came first (Nautilus);
 * - the time limit exits at the close of the first bar ending at or after it.
 */
export function evaluateBarriers(
  position: Pick<OpenPosition, 'stopLoss' | 'takeProfit' | 'expiresAt'>,
  bars: readonly Candle[],
  barMs: number,
): BarrierExit | null {
  const { stopLoss: stop, takeProfit: target, expiresAt } = position;
  for (const bar of bars) {
    if (stop !== null && bar.o <= stop) return { reason: 'stop', price: bar.o, ts: bar.t };
    if (target !== null && bar.o >= target) return { reason: 'target', price: bar.o, ts: bar.t };
    const hitsStop = stop !== null && bar.l <= stop;
    const hitsTarget = target !== null && bar.h >= target;
    if (hitsStop) return { reason: 'stop', price: stop!, ts: bar.t };
    if (hitsTarget) return { reason: 'target', price: target!, ts: bar.t };
    const close = bar.t + barMs;
    if (expiresAt !== null && close >= expiresAt) return { reason: 'time', price: bar.c, ts: close };
  }
  return null;
}
