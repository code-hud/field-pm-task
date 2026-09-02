import { useMemo, useState } from 'react';

import { useElementWidth } from './useElementWidth.js';

const PADDING = { top: 16, right: 64, bottom: 26, left: 8 };

/**
 * Single-series line chart.
 *
 * Mark specs: 2px line with round joins, ~10% area wash, hairline solid gridlines,
 * an 8px end marker with a 2px surface ring, and one direct label at the endpoint.
 * A single series carries no legend — the card title names what is plotted. The
 * crosshair + tooltip is the default hover layer; keyboard focus moves the same
 * readout, and the caller ships a table twin so no value is tooltip-gated.
 */
export function LineChart({
  points,
  height = 260,
  valueFormat = (value) => String(value),
  // Axis ticks are usually abbreviated where the tooltip and end label are not.
  tickFormat,
  labelFormat = (label) => String(label),
  tickCount = 4,
  color = 'var(--series-1)',
  ariaLabel,
  stale = false,
}) {
  const [wrapRef, width] = useElementWidth();
  const [activeIndex, setActiveIndex] = useState(null);

  const geometry = useMemo(() => {
    if (!points || points.length < 2) return null;

    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Pad the domain so the line never rides the frame; keep a floor for flat series.
    const span = max - min || Math.abs(max) * 0.02 || 1;
    const domainMin = min - span * 0.08;
    const domainMax = max + span * 0.08;

    const plotWidth = Math.max(width - PADDING.left - PADDING.right, 10);
    const plotHeight = Math.max(height - PADDING.top - PADDING.bottom, 10);

    const x = (index) => PADDING.left + (index / (points.length - 1)) * plotWidth;
    const y = (value) =>
      PADDING.top + plotHeight - ((value - domainMin) / (domainMax - domainMin)) * plotHeight;

    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point.value)}`).join(' ');
    const baseline = PADDING.top + plotHeight;
    const area = `${line} L${x(points.length - 1)},${baseline} L${x(0)},${baseline} Z`;

    // Clean-ish y ticks across the padded domain.
    const ticks = Array.from({ length: tickCount }, (_, index) => {
      const value = domainMin + ((domainMax - domainMin) * index) / (tickCount - 1);
      return { value, y: y(value) };
    });

    return { x, y, line, area, ticks, baseline, plotWidth, plotHeight };
  }, [points, width, height, tickCount]);

  if (!geometry) {
    return (
      <div ref={wrapRef} className="chart">
        <div className="state">Not enough data to plot.</div>
      </div>
    );
  }

  const lastIndex = points.length - 1;
  const readIndex = activeIndex ?? lastIndex;
  const readPoint = points[readIndex];
  const endY = geometry.y(points[lastIndex].value);

  const pickIndex = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left - PADDING.left;
    const ratio = offset / geometry.plotWidth;
    return Math.max(0, Math.min(lastIndex, Math.round(ratio * lastIndex)));
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      setActiveIndex(Math.max(0, Math.min(lastIndex, readIndex + step)));
    }
    if (event.key === 'Escape') setActiveIndex(null);
  };

  return (
    <div ref={wrapRef} className={`chart${stale ? ' chart--stale' : ''}`}>
      <svg
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onMouseMove={(event) => setActiveIndex(pickIndex(event))}
        onMouseLeave={() => setActiveIndex(null)}
        onKeyDown={onKeyDown}
        onBlur={() => setActiveIndex(null)}
      >
        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            {/* The end label shares the right gutter, so drop the tick text it
                would overlap — the gridline still stays. */}
            {Math.abs(tick.y - endY) >= 13 && (
              <text className="chart__tick" x={width - PADDING.right + 8} y={tick.y + 4}>
                {(tickFormat ?? valueFormat)(tick.value)}
              </text>
            )}
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--gridline)"
              strokeWidth="1"
            />
          </g>
        ))}

        <line
          x1={PADDING.left}
          x2={width - PADDING.right}
          y1={geometry.baseline}
          y2={geometry.baseline}
          stroke="var(--baseline)"
          strokeWidth="1"
        />

        <path d={geometry.area} fill={color} fillOpacity="0.1" />
        <path
          d={geometry.line}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* x-axis: first and last labels only — dense date ticks add ink, not meaning. */}
        <text className="chart__tick" x={PADDING.left} y={height - 8}>
          {labelFormat(points[0].label)}
        </text>
        <text className="chart__tick" x={width - PADDING.right} y={height - 8} textAnchor="end">
          {labelFormat(points[lastIndex].label)}
        </text>

        {activeIndex !== null && (
          <line
            x1={geometry.x(activeIndex)}
            x2={geometry.x(activeIndex)}
            y1={PADDING.top}
            y2={geometry.baseline}
            stroke="var(--border-strong)"
            strokeWidth="1"
          />
        )}

        {/* End marker: 8px dot with a 2px surface ring so it reads over the line. */}
        <circle
          cx={geometry.x(readIndex)}
          cy={geometry.y(readPoint.value)}
          r="4"
          fill={color}
          stroke="var(--surface)"
          strokeWidth="2"
        />

        {activeIndex === null && (
          <text
            className="chart__endlabel"
            x={geometry.x(lastIndex) + 10}
            y={geometry.y(points[lastIndex].value) + 4}
          >
            {valueFormat(points[lastIndex].value)}
          </text>
        )}
      </svg>

      {activeIndex !== null && (
        <div
          className="chart__tooltip"
          style={{
            left: `${geometry.x(activeIndex)}px`,
            top: `${geometry.y(readPoint.value) - 12}px`,
          }}
        >
          <div className="chart__tooltip-label">{labelFormat(readPoint.label)}</div>
          <div className="chart__tooltip-value">{valueFormat(readPoint.value)}</div>
        </div>
      )}
    </div>
  );
}
