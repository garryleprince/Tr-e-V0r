import type { Candle } from '../domain/market';
import { TIMEFRAME_MS, type Timeframe } from '../domain/time';

/**
 * Validation plan: TRAIN / VALIDATION / TEST / OUT-OF-SAMPLE.
 *
 * Segments are half-open time ranges `[start, end)` on bar OPEN times. Between
 * two consecutive segments there must be an embargo of at least `embargoBars`
 * bars, so that no bar of a segment is inside the indicator look-back of the
 * previous one's last decision (Qlib's trunc_segments idea, applied to time).
 *
 * Indicators of a segment MAY read bars from earlier segments — that is the
 * past, not a leak. What must never happen is choosing parameters on TEST or
 * OUT-OF-SAMPLE: that discipline is procedural and recorded with each run.
 */

export const SEGMENT_NAMES = ['TRAIN', 'VALIDATION', 'TEST', 'OOS'] as const;
export type SegmentName = (typeof SEGMENT_NAMES)[number];

export const SEGMENT_LABELS: Readonly<Record<SegmentName, string>> = {
  TRAIN: 'Entraînement',
  VALIDATION: 'Validation',
  TEST: 'Test',
  OOS: 'Hors échantillon',
};

export interface Segment {
  readonly name: SegmentName;
  readonly start: number;
  readonly end: number;
}

export interface BacktestPlan {
  readonly timeframe: Timeframe;
  readonly embargoBars: number;
  readonly segments: readonly Segment[];
}

export function validatePlan(plan: BacktestPlan): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const barMs = TIMEFRAME_MS[plan.timeframe];
  if (!Number.isInteger(plan.embargoBars) || plan.embargoBars < 0) {
    errors.push('embargo invalide');
  }
  const names = plan.segments.map((s) => s.name);
  if (new Set(names).size !== names.length) errors.push('segments en double');
  const expectedOrder = SEGMENT_NAMES.filter((n) => names.includes(n));
  if (names.join() !== expectedOrder.join()) {
    errors.push(`ordre attendu : ${expectedOrder.join(' → ')}`);
  }
  plan.segments.forEach((s, i) => {
    if (!(s.end > s.start)) errors.push(`${s.name} : période vide ou inversée`);
    const prev = plan.segments[i - 1];
    if (prev) {
      if (s.start < prev.end) errors.push(`${prev.name} et ${s.name} se chevauchent`);
      const gapBars = (s.start - prev.end) / barMs;
      if (gapBars < plan.embargoBars) {
        errors.push(
          `embargo insuffisant entre ${prev.name} et ${s.name} : ${Math.floor(gapBars)} bougies, ${plan.embargoBars} requises`,
        );
      }
    }
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Proposes a plan over `[first, last]` with the given fractions for
 * TRAIN / VALIDATION / TEST / OOS, embargo carved out of the boundaries.
 */
export function proposePlan(
  first: number,
  last: number,
  timeframe: Timeframe,
  embargoBars: number,
  fractions: readonly [number, number, number, number] = [0.5, 0.2, 0.15, 0.15],
): BacktestPlan {
  const barMs = TIMEFRAME_MS[timeframe];
  const totalBars = Math.floor((last - first) / barMs) + 1;
  const usable = totalBars - embargoBars * 3;
  if (usable < 4) throw new RangeError('historique trop court pour quatre segments avec embargo');
  const sizes = fractions.map((f) => Math.max(1, Math.floor(usable * f)));
  const segments: Segment[] = [];
  let cursor = first;
  SEGMENT_NAMES.forEach((name, i) => {
    const start = cursor;
    const end = start + sizes[i]! * barMs;
    segments.push({ name, start, end });
    cursor = end + embargoBars * barMs;
  });
  return { timeframe, embargoBars, segments };
}

export function candlesIn(candles: readonly Candle[], segment: Segment): Candle[] {
  return candles.filter((k) => k.t >= segment.start && k.t < segment.end);
}
