import { AreaSeries, ColorType, createChart, CrosshairMode, LineStyle, type MouseEventParams, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateTime, money, pct, time } from '../app/format';
import { useChartPalette, withAlpha } from './theme';

interface Point {
  readonly t: number;
  readonly equity: number;
  readonly drawdown: number;
}

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

/**
 * Simulated equity (one series, one axis) and, in a separate pane below, its
 * drawdown from the running peak — two measures, two scales, never one dual axis.
 */
export function EquityChart({ curve, currency, height = 300 }: { curve: readonly Point[]; currency: string; height?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const palette = useChartPalette();
  const [hover, setHover] = useState<Point | null>(null);

  // One point per second: the chart needs strictly increasing times.
  const points = useMemo(() => {
    const m = new Map<number, Point>();
    // Drawdown is plotted below zero: deeper loss, lower line.
    for (const p of curve) m.set(sec(p.t), { ...p, drawdown: -Math.abs(p.drawdown) });
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [curve]);

  useEffect(() => {
    const el = container.current;
    if (!el || points.length < 2) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: palette.surface },
        textColor: palette.axis,
        fontFamily: palette.font,
        fontSize: 11,
        attributionLogo: true,
        panes: { separatorColor: palette.grid, separatorHoverColor: palette.grid, enableResize: false },
      },
      grid: { vertLines: { visible: false }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderVisible: false },
      // Snapshots are instants, shown in the phone's time zone (candle charts keep UTC session dates).
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: (t: Time) => (typeof t === 'number' ? shortTick(t * 1000) : ''),
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: palette.axis, labelBackgroundColor: palette.axis, style: LineStyle.Dotted },
        horzLine: { color: palette.axis, labelBackgroundColor: palette.axis, style: LineStyle.Dotted },
      },
      localization: { locale: 'fr-FR', timeFormatter: (t: Time) => (typeof t === 'number' ? dateTime(t * 1000) : '') },
      handleScroll: { vertTouchDrag: false },
    });
    const equity = chart.addSeries(AreaSeries, {
      lineColor: palette.up,
      topColor: withAlpha(palette.up, 0.28),
      bottomColor: withAlpha(palette.up, 0.02),
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: { type: 'custom', formatter: (v: number) => money(v, currency, { compact: true }), minMove: 0.01 },
    });
    equity.setData(points.map(([t, p]) => ({ time: t as UTCTimestamp, value: p.equity })));
    const dd = chart.addSeries(
      AreaSeries,
      {
        lineColor: palette.bad,
        topColor: withAlpha(palette.bad, 0.3),
        bottomColor: withAlpha(palette.bad, 0.04),
        invertFilledArea: true,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: 'custom', formatter: (v: number) => pct(v, { digits: 1 }), minMove: 0.0001 },
      },
      1,
    );
    dd.setData(points.map(([t, p]) => ({ time: t as UTCTimestamp, value: p.drawdown })));
    chart.panes()[1]?.setStretchFactor(0.4);
    chart.timeScale().fitContent();

    const index = new Map(points);
    const onMove = (param: MouseEventParams<Time>) => {
      setHover(param.time !== undefined && param.point ? (index.get(param.time as number) ?? null) : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
    };
  }, [points, palette, currency]);

  if (points.length < 2) return null;
  const shown = hover ?? points[points.length - 1]![1];
  return (
    <figure className="chart-figure">
      <figcaption className="chart-legend">
        <div className="legend-row num">
          <span className="dim">{dateTime(shown.t)}</span>
          <span className="legend-key">
            <span className="swatch swatch-line" style={{ background: palette.up }} aria-hidden="true" />
            Capital {money(shown.equity, currency)}
          </span>
          <span className="legend-key">
            <span className="swatch swatch-line" style={{ background: palette.bad }} aria-hidden="true" />
            Drawdown {pct(shown.drawdown, { digits: 2 })}
          </span>
        </div>
      </figcaption>
      <div ref={container} className="chart-canvas" style={{ height }} role="img" aria-label="Courbe du capital simulé et drawdown. Les valeurs sont disponibles en vue tableau." />
    </figure>
  );
}

const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

/** Axis tick: the time for today's points, the date otherwise. */
function shortTick(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? time(ms) : dayFmt.format(ms);
}
