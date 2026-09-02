const currency0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const currency2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const money = (value, { cents = true } = {}) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return cents ? currency2.format(value) : currency0.format(value);
};

/** Signed money, for deltas that always show their direction. */
export const signedMoney = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${currency2.format(Math.abs(value))}`;
};

export const percent = (value, { digits = 2 } = {}) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}%`;
};

export const signedPercent = (value, { digits = 2 } = {}) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}%`;
};

export const shares = (value) => (value === null || value === undefined ? '—' : integer.format(value));

export const compactNumber = (value) =>
  value === null || value === undefined ? '—' : compact.format(value);

export const compactMoney = (value) =>
  value === null || value === undefined ? '—' : `$${compact.format(value)}`;

export const marketCap = (billions) =>
  billions === null || billions === undefined
    ? '—'
    : billions >= 1000
      ? `$${(billions / 1000).toFixed(2)}T`
      : `$${billions.toFixed(1)}B`;

export const ratio = (value, digits = 2) =>
  value === null || value === undefined ? '—' : value.toFixed(digits);

export const shortDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export const mediumDate = (isoDate) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export const clockTime = (isoTimestamp) =>
  isoTimestamp
    ? new Date(isoTimestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

/** −1 / 0 / 1 — drives both the delta color and its glyph. */
export const direction = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
