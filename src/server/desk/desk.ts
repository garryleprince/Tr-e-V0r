import type { AccountCurrency } from '../../core/domain/fx';
import { DurableObject } from 'cloudflare:workers';
import type { Mode, TradingState } from '../../core/domain/trading';
import { readConfig, type Env } from '../env';
import { SerialQueue } from './serial-queue';
import { DeskCore, type DeskView, type MonitorInput, type MonitorResult, type SubmitRequest, type SubmitResult } from './desk-core';

/**
 * The TradingDesk Durable Object: the single, serialised entry point for every
 * state change of the trading book (docs/ARCHITECTURE.md §1). One instance
 * exists (`idFromName('desk')`); the Worker calls it through RPC.
 */
export class TradingDesk extends DurableObject<Env> {
  private readonly queue = new SerialQueue();

  private core(): DeskCore {
    return new DeskCore(this.env.DB, readConfig(this.env), () => Date.now());
  }

  view(): Promise<DeskView> {
    return this.queue.run(() => this.core().view());
  }

  setTradingState(target: TradingState, reason: string, stepUp: boolean): Promise<DeskView> {
    return this.queue.run(() => this.core().setTradingState(target, { reason, actor: 'user', stepUp }));
  }

  setMode(target: Mode, stepUp: boolean): Promise<DeskView> {
    return this.queue.run(() => this.core().setMode(target, { actor: 'user', stepUp }));
  }

  submit(req: SubmitRequest): Promise<SubmitResult> {
    return this.queue.run(() => this.core().submit(req));
  }

  monitor(inputs: MonitorInput[]): Promise<MonitorResult> {
    return this.queue.run(() => this.core().monitor(inputs));
  }

  closeManually(positionId: string, market: { price: number; bid: number | null; ask: number | null }): Promise<SubmitResult> {
    return this.queue.run(() => this.core().closeManually(positionId, market));
  }

  resetPaper(startingCash: number, stepUp: boolean, currency?: AccountCurrency) {
    return this.queue.run(() => this.core().resetPaper(startingCash, stepUp, currency));
  }
}
