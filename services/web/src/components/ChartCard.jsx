import { useId, useState } from 'react';

/**
 * A chart in a card, with the table twin every chart is required to have.
 * Range/dimension controls belong in `actions` — one row above the plot, never
 * inside it.
 */
export function ChartCard({ title, subtitle, actions, children, table, flush = false }) {
  const [view, setView] = useState('chart');
  const id = useId();

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <header className="card__head">
        <div className="card__titles">
          <h2 className="card__title" id={`${id}-title`}>
            {title}
          </h2>
          {subtitle && <p className="card__subtitle">{subtitle}</p>}
        </div>
        {actions}
        {table && (
          <div className="segmented" role="group" aria-label={`${title} view`}>
            <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
              Chart
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
              Table
            </button>
          </div>
        )}
      </header>
      <div className={`card__body${flush && view === 'table' ? ' card__body--flush' : ''}`}>
        {view === 'chart' ? children : table}
      </div>
    </section>
  );
}

/** Segmented range picker — shared by the equity curve and the price chart. */
export function RangePicker({ label, value, options, onChange }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
