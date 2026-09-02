/** Money for a human-readable denial reason: thousands separators, two decimals. */
function money(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { money };
