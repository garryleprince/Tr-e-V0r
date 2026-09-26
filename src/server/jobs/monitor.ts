import { barCloseTime, TIMEFRAME_MS, type Timeframe } from '../../core/domain/time';
import { CandleService } from '../data/candle-service';
import { beat, getInstrument } from '../db/core';
import { openPositions } from '../db/trading';
import type { MonitorInput, MonitorResult } from '../desk/desk-core';
import { errorMessage, log } from '../util';

/**
 * Position monitoring (every 15 minutes): triple barrier, mark-to-market,
 * automatic kill switch on drawdown or daily loss.
 *
 * Crypto positions are checked on 15-minute bars. Equities from the free
 * Alpha Vantage tier only have daily bars: their stops are checked once per
 * day — a documented limitation (docs/LIMITATIONS.md).
 */

export interface MonitorDeps {
  readonly db: D1Database;
  readonly candles: CandleService;
  readonly desk: { monitor(inputs: MonitorInput[]): Promise<MonitorResult> };
  readonly now: () => number;
}

export async function runMonitor(deps: MonitorDeps): Promise<MonitorResult> {
  const { db, now } = deps;
  const positions = await openPositions(db, 'PAPER');
  const inputs: MonitorInput[] = [];
  for (const p of positions) {
    const instrument = await getInstrument(db, p.instrumentId);
    if (!instrument) continue;
    const tf: Timeframe = deps.candles.providersFor(instrument, '15m').length > 0 ? '15m' : '1d';
    try {
      const { candles } = await deps.candles.getClosedCandles(instrument, tf, tf === '15m' ? 200 : 10);
      // Only bars that opened after the fill and closed after the last check:
      // a bar that began before the entry says nothing about this position.
      const bars = candles.filter((k) => k.t >= p.openedAt && barCloseTime(k.t, tf) > p.lastCheckedAt);
      const quote = await deps.candles.getQuote(instrument);
      const last = candles[candles.length - 1];
      const mark = quote ? { price: quote.last, bid: quote.bid, ask: quote.ask, ts: quote.ts } : last ? { price: last.c, bid: null, ask: null, ts: barCloseTime(last.t, tf) } : null;
      inputs.push({ positionId: p.id, bars, barMs: TIMEFRAME_MS[tf], mark });
    } catch (err) {
      log('warn', 'monitor could not read prices', { positionId: p.id, error: errorMessage(err) });
      inputs.push({ positionId: p.id, bars: [], barMs: TIMEFRAME_MS[tf], mark: null });
    }
  }
  const result = await deps.desk.monitor(inputs);
  await beat(db, 'monitor', now(), 'ok', `${positions.length} position(s), ${result.exits.length} sortie(s)`);
  return result;
}
