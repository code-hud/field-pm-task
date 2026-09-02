/**
 * Row-level sparkline: a 2px line with a rounded cap and an end dot carrying a 2px
 * surface ring. Direction is colored with the delta tokens, and every row that shows
 * one also shows its signed change in the next column — so the color is a reinforcement,
 * never the only channel. No axes or labels; the table cell beside it holds the values.
 */
export function Sparkline({ values, changePercent, width = 84, height = 28, ariaLabel }) {
  if (!values || values.length < 2) return <span aria-hidden="true">—</span>;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const inset = 3; // room for the end dot's ring

  const x = (index) => inset + (index / (values.length - 1)) * (width - inset * 2);
  const y = (value) => inset + (1 - (value - min) / span) * (height - inset * 2);

  const path = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ');

  // Color from the same measure the delta column shows (change vs previous close),
  // not from the shape of the series — an issuer that gapped down at the open but
  // rose through the session must not read green next to a red number.
  const rising = (changePercent ?? values.at(-1) - values[0]) >= 0;
  const color = rising ? 'var(--delta-up)' : 'var(--delta-down)';

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? `Intraday trend, ${rising ? 'up' : 'down'} on the session`}
    >
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle
        cx={x(values.length - 1)}
        cy={y(values.at(-1))}
        r="2.5"
        fill={color}
        stroke="var(--surface)"
        strokeWidth="2"
      />
    </svg>
  );
}
