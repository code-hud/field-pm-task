const VARIANT = {
  regular: 'pill--open',
  'pre-market': 'pill--extended',
  'after-hours': 'pill--extended',
  closed: '',
};

/** Session state. The dot is decorative — the label carries the meaning. */
export function MarketStatusPill({ status }) {
  if (!status) return null;
  return (
    <span className={`pill ${VARIANT[status.phase] ?? ''}`.trim()}>
      <span className="pill__dot" aria-hidden="true" />
      {status.label}
    </span>
  );
}
