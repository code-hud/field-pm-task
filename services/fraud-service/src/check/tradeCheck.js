/**
 * The normalised trade a rule sees. Normalising once, here, is what lets a rule be a
 * single expression: it reads `notional` without multiplying and compares `symbol`
 * without upper-casing first.
 *
 * Notional is quantity × price, rounded to the cent — deliberately NOT accepted from the
 * caller, since a supplied notional could disagree with its own inputs.
 */
function tradeCheck(request) {
  const notional = round2(request.price * request.quantity);
  return {
    accountId: String(request.accountId).trim(),
    symbol: String(request.symbol).trim().toUpperCase(),
    side: request.side,
    quantity: request.quantity,
    price: request.price,
    notional,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { tradeCheck };
