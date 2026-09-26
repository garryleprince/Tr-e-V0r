/**
 * 30-bar closing-price sparkline. Colour follows the direction of the window
 * (blue up / orange down); the adjacent change figure carries ▲ ▼, so the
 * direction never relies on hue alone. Decorative: the numbers are in the row.
 */
export function Sparkline({ values, width = 88, height = 32 }: { values: readonly number[]; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = values[values.length - 1]! >= values[0]!;
  const last = pts[pts.length - 1]!.split(',');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`sparkline ${up ? 'up' : 'down'}`} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill="currentColor" />
    </svg>
  );
}
