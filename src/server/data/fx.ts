import { FX_INSTRUMENTS } from '../../core/domain/fx';
import { getInstrument, latestFxRates, type FxView } from '../db/core';
import { errorMessage, log } from '../util';
import type { CandleService } from './candle-service';

/**
 * Refreshes the daily FX bars (cached like any other candles, one vendor call a
 * day at most) and returns the resulting view. A failure is logged and the last
 * known rates are served: valuations continue, openings stay blocked when the
 * rate becomes stale (see FX_MAX_AGE_MS).
 */
export async function refreshFx(db: D1Database, candles: CandleService, now: number): Promise<FxView> {
  for (const id of Object.values(FX_INSTRUMENTS)) {
    const instrument = await getInstrument(db, id);
    if (!instrument) continue;
    try {
      await candles.getClosedCandles(instrument, '1d', 30);
    } catch (err) {
      log('warn', 'fx refresh failed', { instrument: id, error: errorMessage(err) });
    }
  }
  return latestFxRates(db, now);
}
