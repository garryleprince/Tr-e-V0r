import type { Candle, Instrument, Quote } from '../../src/core/domain/market';
import type { Timeframe } from '../../src/core/domain/time';
import type { MarketDataProvider } from '../../src/server/data/types';
import { SerialQueue } from '../../src/server/desk/serial-queue';
import { DeskCore } from '../../src/server/desk/desk-core';
import type { RuntimeConfig } from '../../src/server/env';

export const DEV_CONFIG: RuntimeConfig = {
  production: false,
  killSwitchForced: false,
  liveTradingEnabled: false,
  marketDataMode: 'live',
  setupToken: 'setup-token-for-tests',
  sessionPepper: 'pepper',
  keys: { anthropic: null, openaiCompatible: null, alphaVantage: null },
};

/** A controllable clock. */
export function clock(start: number) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** In-memory provider returning whatever the test gives it, possibly including an unclosed bar. */
export class FakeProvider implements MarketDataProvider {
  calls = 0;
  failWith: Error | null = null;
  quote: Quote | null = null;
  constructor(
    readonly id: string,
    private readonly data: Record<string, Candle[]>,
    readonly label = id,
    private readonly timeframes: Timeframe[] = ['1d', '15m'],
  ) {}

  supports(instrument: Instrument, tf: Timeframe): boolean {
    return instrument.id in this.data && this.timeframes.includes(tf);
  }

  async fetchCandles(instrument: Instrument, _tf: Timeframe, limit: number): Promise<Candle[]> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return (this.data[instrument.id] ?? []).slice(-limit);
  }

  async fetchQuote(): Promise<Quote | null> {
    return this.quote;
  }

  setData(id: string, candles: Candle[]) {
    this.data[id] = candles;
  }
}

/**
 * A stand-in for the Durable Object namespace: same serialisation, same
 * DeskCore, callable exactly like the RPC stub.
 */
export function fakeDeskNamespace(db: D1Database, config: RuntimeConfig, now: () => number) {
  const queue = new SerialQueue();
  const core = () => new DeskCore(db, config, now);
  const stub = {
    view: () => queue.run(() => core().view()),
    setTradingState: (target: never, reason: string, stepUp: boolean) =>
      queue.run(() => core().setTradingState(target, { reason, actor: 'user', stepUp })),
    setMode: (target: never, stepUp: boolean) => queue.run(() => core().setMode(target, { actor: 'user', stepUp })),
    submit: (req: never) => queue.run(() => core().submit(req)),
    monitor: (inputs: never) => queue.run(() => core().monitor(inputs)),
    closeManually: (id: string, market: never) => queue.run(() => core().closeManually(id, market)),
    resetPaper: (cash: number, stepUp: boolean) => queue.run(() => core().resetPaper(cash, stepUp)),
  };
  return {
    stub,
    namespace: { idFromName: () => 'desk', get: () => stub } as unknown as DurableObjectNamespace,
  };
}
