import { useEffect, useState } from 'react';
import { useApp } from '../app/store';

/**
 * Chart colours come from the CSS tokens, so charts follow the selected theme.
 * Each theme's values were validated separately against its own surface
 * (dataviz validator: CVD separation, lightness band, contrast).
 */
export interface ChartPalette {
  readonly surface: string;
  readonly grid: string;
  readonly axis: string;
  readonly text: string;
  readonly textMuted: string;
  readonly up: string;
  readonly down: string;
  readonly upDim: string;
  readonly downDim: string;
  readonly series3: string;
  readonly muted: string;
  readonly good: string;
  readonly bad: string;
  readonly badDim: string;
  readonly font: string;
}

function readPalette(): ChartPalette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    surface: v('--chart-surface'),
    grid: v('--chart-grid'),
    axis: v('--chart-axis'),
    text: v('--text-1'),
    textMuted: v('--text-2'),
    up: v('--up'),
    down: v('--down'),
    upDim: v('--up-dim'),
    downDim: v('--down-dim'),
    series3: v('--series-3'),
    muted: v('--series-muted'),
    good: v('--good'),
    bad: v('--bad'),
    badDim: v('--bad-dim'),
    font: v('--font'),
  };
}

/** Current palette; re-read when the theme setting or the OS appearance changes. */
export function useChartPalette(): ChartPalette {
  const theme = useApp((s) => s.theme);
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    setPalette(readPalette());
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setPalette(readPalette());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
  return palette;
}

/** `#rrggbb` → `rgba(r, g, b, a)`; any other colour string is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
