import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { arrow, barDate, compact, dirClass, pct, price } from '../app/format';
import type { Candle, SeriesPoint } from '../app/types';
import { useChartPalette, withAlpha } from './theme';

export interface PriceLevel {
  readonly price: number;
  readonly kind: 'entry' | 'stop' | 'target';
  readonly label: string;
}

export interface ChartMarker {
  readonly t: number;
  readonly side: 'buy' | 'sell';
  readonly label: string;
}

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

interface Hover {
  readonly candle: Candle;
  readonly prevClose: number | null;
  readonly sma50: number | null;
  readonly sma200: number | null;
}

/**
 * Candles (blue up / orange down: a colour-blind-safe pair), volume in its own
 * pane (never a second axis), MM50 and MM200 lines, labelled Entry / Stop /
 * Target levels, and a crosshair whose values show in the legend above.
 * TradingView attribution stays on, as the Apache-2.0 licence NOTICE requires.
 */
export function CandleChart({
  candles,
  sma50,
  sma200,
  levels = [],
  markers = [],
  currency,
  height = 360,
}: {
  candles: readonly Candle[];
  sma50: readonly SeriesPoint[];
  sma200: readonly SeriesPoint[];
  levels?: readonly PriceLevel[];
  markers?: readonly ChartMarker[];
  currency: string;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const palette = useChartPalette();
  const [hover, setHover] = useState<Hover | null>(null);

  const byTime = useMemo(() => {
    const m50 = new Map(sma50.map((p) => [p.t, p.v]));
    const m200 = new Map(sma200.map((p) => [p.t, p.v]));
    const index = new Map(candles.map((k, i) => [sec(k.t) as number, i]));
    return { m50, m200, index };
  }, [candles, sma50, sma200]);

  const lastHover = useMemo<Hover | null>(() => {
    const k = candles[candles.length - 1];
    if (!k) return null;
    return {
      candle: k,
      prevClose: candles[candles.length - 2]?.c ?? null,
      sma50: byTime.m50.get(k.t) ?? null,
      sma200: byTime.m200.get(k.t) ?? null,
    };
  }, [candles, byTime]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { borderVisible: false, rightOffset: 3, fixLeftEdge: true },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: palette.axis, labelBackgroundColor: palette.axis, style: LineStyle.Dotted },
        horzLine: { color: palette.axis, labelBackgroundColor: palette.axis, style: LineStyle.Dotted },
      },
      localization: { locale: 'fr-FR' },
      handleScroll: { vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: { price: false, time: true } },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderUpColor: palette.up,
      borderDownColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: 'custom', formatter: (p: number) => price(p), minMove: minMove(candles) },
    });
    candleSeries.setData(candles.map((k) => ({ time: sec(k.t), open: k.o, high: k.h, low: k.l, close: k.c })));

    const s200 = chart.addSeries(LineSeries, {
      color: palette.muted,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    s200.setData(sma200.map((p) => ({ time: sec(p.t), value: p.v })));
    const s50 = chart.addSeries(LineSeries, {
      color: palette.series3,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    s50.setData(sma50.map((p) => ({ time: sec(p.t), value: p.v })));

    const volume: ISeriesApi<'Histogram'> = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'custom', formatter: (v: number) => compact(v), minMove: 1 }, priceLineVisible: false, lastValueVisible: false },
      1,
    );
    volume.setData(candles.map((k) => ({ time: sec(k.t), value: k.v, color: withAlpha(k.c >= k.o ? palette.up : palette.down, 0.5) })));
    chart.panes()[0]?.setStretchFactor(1);
    chart.panes()[1]?.setStretchFactor(0.24);

    for (const level of levels) {
      candleSeries.createPriceLine({
        price: level.price,
        color: level.kind === 'stop' ? palette.bad : level.kind === 'target' ? palette.good : palette.textMuted,
        lineWidth: 1,
        lineStyle: level.kind === 'entry' ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title: level.label,
      });
    }

    const times = new Set(candles.map((k) => sec(k.t) as number));
    const seriesMarkers: SeriesMarker<Time>[] = markers
      .map((m) => ({ ...m, time: nearestBarTime(candles, m.t) }))
      .filter((m): m is typeof m & { time: UTCTimestamp } => m.time !== null && times.has(m.time))
      .map((m) => ({
        time: m.time,
        position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: m.side === 'buy' ? palette.up : palette.down,
        text: m.label,
        size: 1.2,
      }));
    if (seriesMarkers.length > 0) createSeriesMarkers(candleSeries, seriesMarkers);

    const n = candles.length;
    if (n > 0) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 2 });

    const onMove = (param: MouseEventParams<Time>) => {
      if (param.time === undefined || !param.point || param.point.x < 0) {
        setHover(null);
        return;
      }
      const d = param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined;
      const i = byTime.index.get(param.time as number);
      if (!d || i === undefined) {
        setHover(null);
        return;
      }
      const k = candles[i]!;
      setHover({ candle: k, prevClose: candles[i - 1]?.c ?? null, sma50: byTime.m50.get(k.t) ?? null, sma200: byTime.m200.get(k.t) ?? null });
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, sma50, sma200, levels, markers, palette, byTime]);

  const h = hover ?? lastHover;
  const change = h && h.prevClose ? h.candle.c / h.prevClose - 1 : null;

  return (
    <figure className="chart-figure">
      <figcaption className="chart-legend" aria-live="off">
        {h ? (
          <>
            <div className="legend-row num">
              <span className="dim">{barDate(h.candle.t)}</span>
              <span>
                <span className="dim">O</span> {price(h.candle.o)}
              </span>
              <span>
                <span className="dim">H</span> {price(h.candle.h)}
              </span>
              <span>
                <span className="dim">B</span> {price(h.candle.l)}
              </span>
              <span>
                <span className="dim">C</span> {price(h.candle.c, currency)}
              </span>
              <span className={dirClass(change)}>
                {arrow(change)} {pct(change, { sign: true })}
              </span>
            </div>
            <div className="legend-row num">
              <span className="legend-key">
                <span className="swatch swatch-line" style={{ background: palette.series3 }} aria-hidden="true" />
                MM50 {price(h.sma50)}
              </span>
              <span className="legend-key">
                <span className="swatch swatch-line" style={{ background: palette.muted }} aria-hidden="true" />
                MM200 {price(h.sma200)}
              </span>
              <span className="legend-key">
                <span className="dim">Vol.</span> {compact(h.candle.v)}
              </span>
            </div>
          </>
        ) : null}
      </figcaption>
      <div ref={container} className="chart-canvas" style={{ height }} role="img" aria-label="Graphique en chandeliers avec volume et moyennes mobiles. Les valeurs détaillées sont disponibles en vue tableau." />
    </figure>
  );
}

/** Smallest price step worth displaying: two decimals above 1, more below. */
function minMove(candles: readonly Candle[]): number {
  const last = candles[candles.length - 1]?.c ?? 1;
  return last >= 1 ? 0.01 : last >= 0.01 ? 0.0001 : 0.000001;
}

/** A marker snaps to the bar that contains its timestamp. */
function nearestBarTime(candles: readonly Candle[], t: number): UTCTimestamp | null {
  let best: Candle | null = null;
  for (const k of candles) {
    if (k.t <= t) best = k;
    else break;
  }
  return best ? sec(best.t) : null;
}
