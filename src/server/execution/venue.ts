import type { Fill } from '../../core/domain/trading';
import type { ApprovedOrder } from '../../core/risk/engine';
import { fillMarketOrder, type CostModel } from '../../core/sim/exchange';

/**
 * Execution port. A venue accepts ONLY an `ApprovedOrder`, a type that the Risk
 * Engine alone can construct — bypassing risk is a compile error.
 *
 * V0.1 ships the paper venue. A live venue (V1) will add: client order ids
 * made idempotent across retries, "unknown outcome" handling and
 * reconciliation (NautilusTrader), rate limits and trading-rule quantisation
 * (Hummingbot).
 */
export interface ExecutionVenue {
  readonly id: string;
  readonly live: boolean;
  execute(order: ApprovedOrder, market: { referencePrice: number; bid: number | null; ask: number | null; ts: number }): Promise<ExecutionReport>;
}

export type ExecutionReport =
  | { readonly status: 'FILLED'; readonly fill: Fill }
  | { readonly status: 'REJECTED'; readonly reason: string };

export class PaperVenue implements ExecutionVenue {
  readonly id = 'paper';
  readonly live = false;
  constructor(private readonly costs: CostModel) {}

  async execute(
    order: ApprovedOrder,
    market: { referencePrice: number; bid: number | null; ask: number | null; ts: number },
  ): Promise<ExecutionReport> {
    if (!(order.quantity > 0)) return { status: 'REJECTED', reason: 'quantité nulle' };
    return { status: 'FILLED', fill: fillMarketOrder(order.side, order.quantity, market, this.costs) };
  }
}
