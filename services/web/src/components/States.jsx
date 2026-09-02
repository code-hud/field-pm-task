export function LoadingState({ label = 'Loading…', height = 220 }) {
  return (
    <div className="state" style={{ minHeight: height }} role="status">
      <div className="skeleton" style={{ width: '100%', height: height - 48 }} />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this data' }) {
  return (
    <div className="state" role="alert">
      <span className="state__title">{title}</span>
      <span>{error?.message ?? 'Unexpected error.'}</span>
      {onRetry && (
        <button type="button" className="button button--ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The data on screen is real, and the attempt to update it failed.
 *
 * Deliberately not an `ErrorState`. Nothing is broken from the reader's point of
 * view — they are looking at something true, just not current — and replacing a
 * working page with an error card because one poll in a hundred timed out is how a
 * page ends up feeling less reliable than it is.
 *
 * `role="status"` rather than `alert`: this is worth announcing at the next
 * opportunity, not worth interrupting for.
 */
export function StaleNotice({ error, since, onRetry }) {
  return (
    <div className="notice" role="status">
      <span className="notice__glyph" aria-hidden="true">
        ⓘ
      </span>
      <span>
        Last update failed{since ? ` — showing data from ${since}` : ''}.{' '}
        {error?.message ?? ''}
      </span>
      {onRetry && (
        <button
          type="button"
          className="button button--ghost"
          style={{ marginLeft: 'auto' }}
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint }) {
  return (
    <div className="state">
      <span className="state__title">{title}</span>
      {hint && <span>{hint}</span>}
    </div>
  );
}
