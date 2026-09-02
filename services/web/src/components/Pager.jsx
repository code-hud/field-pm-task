/**
 * Offset paging, not infinite scroll.
 *
 * Both lists that use this are logs someone reads deliberately — a screener and an
 * order history — and "row 300 of 503" is a position worth being able to come back
 * to and to reason about. Infinite scroll gives up both.
 *
 * Filters and sort survive a page change because the API applies both before the
 * offset, so this only ever has to move the offset.
 *
 * It renders nothing when everything fits on one page: a pager reading "1–4 of 4"
 * with both buttons disabled is furniture that describes a list the reader can
 * already see in full.
 */
export function Pager({ offset, count, total, pageSize, onChange, label }) {
  const first = offset + 1;
  const last = offset + count;
  const atStart = offset === 0;
  const atEnd = last >= total;
  if (atStart && atEnd) return null;

  return (
    <nav className="pager" aria-label={label}>
      <span className="pager__count">
        {first}–{last} of {total}
      </span>
      <button
        type="button"
        className="button button--ghost"
        disabled={atStart}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        Previous
      </button>
      <button
        type="button"
        className="button button--ghost"
        disabled={atEnd}
        onClick={() => onChange(offset + pageSize)}
      >
        Next
      </button>
    </nav>
  );
}
