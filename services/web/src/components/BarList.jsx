import { useElementWidth } from './useElementWidth.js';

/**
 * Horizontal bars for a part-to-whole breakdown.
 *
 * Nominal categories get one color (slot 1) — darkening bars by size would
 * double-encode length as hue. Bars are 14px with a 4px rounded data-end and a
 * square start at the baseline, and every bar is directly labeled, which is also
 * the relief the light-mode contrast check asks for. Bars are drawn in measured
 * pixels rather than a stretched viewBox, so the corner radius stays circular.
 */
const BAR_HEIGHT = 14;
const RADIUS = 4;

function barPath(width, height, radius) {
  const r = Math.min(radius, width, height / 2);
  if (width <= r) return `M0,0 H${width} V${height} H0 Z`;
  return [
    'M0,0',
    `H${width - r}`,
    `A${r},${r} 0 0 1 ${width},${r}`,
    `V${height - r}`,
    `A${r},${r} 0 0 1 ${width - r},${height}`,
    'H0',
    'Z',
  ].join(' ');
}

function Bar({ ratio, color }) {
  const [ref, width] = useElementWidth(160);
  return (
    <svg ref={ref} className="barlist__track" width="100%" height={BAR_HEIGHT}>
      <path d={barPath(Math.max(ratio * width, 1), BAR_HEIGHT, RADIUS)} fill={color} />
    </svg>
  );
}

export function BarList({ items, valueFormat, color = 'var(--series-1)', stale = false }) {
  if (!items || items.length === 0) return <div className="state">Nothing to show.</div>;

  const max = Math.max(...items.map((item) => item.value), 0) || 1;

  return (
    <div className={`barlist${stale ? ' chart--stale' : ''}`}>
      {items.map((item) => (
        <div key={item.key} className="barlist__row">
          <span className="barlist__label" title={item.label}>
            {item.label}
          </span>
          <Bar ratio={Math.max(item.value / max, 0)} color={color} />
          <span className="barlist__value">{valueFormat(item.value)}</span>
        </div>
      ))}
    </div>
  );
}
