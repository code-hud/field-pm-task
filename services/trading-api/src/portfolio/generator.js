/**
 * Builds a plausible starting portfolio for a username. Pure — it takes the price
 * history it needs and returns rows to insert, so the seeder and the first-login
 * path produce byte-identical accounts.
 *
 * Two properties matter:
 *   1. Determinism — the same username always yields the same holdings and lots.
 *   2. Consistency — cost basis comes off a real historical close on the purchase
 *      date, so P/L and the equity curve agree with the price history by construction.
 */
const { STOCKS, STOCKS_BY_SYMBOL } = require('../data/stocks.js');
const { createRng, hashString, randomBetween, randomInt, sample } = require('../lib/random.js');

const round2 = (value) => Math.round(value * 100) / 100;

const portfolioRng = (username) => createRng(hashString(`portfolio:${username.toLowerCase()}`));

/** The first two draws of the portfolio stream: how many names, and which. */
const drawHoldings = (rng) =>
  sample(rng, STOCKS, randomInt(rng, 5, 9)).sort((a, b) => a.symbol.localeCompare(b.symbol));

/**
 * Which symbols a username will hold, without needing any price history.
 *
 * Callers use this to fetch bars for 5–9 symbols instead of all 503. It replays
 * exactly the draws `generatePortfolio` makes first, so the two cannot disagree
 * — but the moment anything is inserted before them in that function, it can. The
 * seeding tests pin the pair together.
 */
const selectPortfolioSymbols = (username) =>
  drawHoldings(portfolioRng(username)).map((stock) => stock.symbol);

/** Cost basis comes off a real close, so unrealized P/L is plausible not invented. */
function buildLots(rng, dailyBars) {
  const lotCount = rng() < 0.35 ? 2 : 1;
  const lots = [];
  // Keep lots inside the window we can value against.
  const earliest = Math.max(6, Math.floor(dailyBars.length * 0.08));
  let barIndex = randomInt(rng, earliest, dailyBars.length - 4);

  for (let i = 0; i < lotCount; i += 1) {
    const bar = dailyBars[dailyBars.length - 1 - barIndex];
    if (!bar) break;
    const notional = randomBetween(rng, 8_000, 46_000) / lotCount;
    const quantity = Math.max(1, Math.round(notional / bar.close));
    lots.push({
      date: bar.date,
      quantity,
      price: round2(bar.close * randomBetween(rng, 0.995, 1.005)),
    });
    barIndex = Math.max(2, Math.floor(barIndex * randomBetween(rng, 0.25, 0.6)));
  }

  return lots.sort((a, b) => a.date.localeCompare(b.date));
}

/** Quarterly dividend credits for the income-paying names actually held. */
function buildDividends(positions, rng, today) {
  const entries = [];

  for (const position of positions) {
    const stock = STOCKS_BY_SYMBOL.get(position.symbol);
    if (!stock?.dividendYield) continue;

    const perShareYear = stock.basePrice * stock.dividendYield;
    const payDate = new Date(`${position.openedAt}T00:00:00Z`);
    payDate.setUTCMonth(payDate.getUTCMonth() + 3);

    while (payDate <= today) {
      entries.push({
        symbol: position.symbol,
        date: payDate.toISOString().slice(0, 10),
        amount: round2((perShareYear / 4) * position.quantity * randomBetween(rng, 0.96, 1.04)),
      });
      payDate.setUTCMonth(payDate.getUTCMonth() + 3);
    }
  }

  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * @param {string} username
 * @param {Map<string, Array<{date: string, close: number}>>} dailyBarsBySymbol
 * @param {Date} [today]
 * @returns {{positions: Array, dividends: Array, cash: number, fundedAmount: number}}
 */
function generatePortfolio(username, dailyBarsBySymbol, today = new Date()) {
  const rng = portfolioRng(username);
  const picked = drawHoldings(rng);

  const positions = [];
  for (const stock of picked) {
    const bars = dailyBarsBySymbol.get(stock.symbol) ?? [];
    if (bars.length === 0) continue;
    const lots = buildLots(rng, bars);
    if (lots.length === 0) continue;

    positions.push({
      symbol: stock.symbol,
      quantity: lots.reduce((total, lot) => total + lot.quantity, 0),
      openedAt: lots[0].date,
      lots,
    });
  }

  const invested = positions.reduce(
    (total, position) =>
      total + position.lots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0),
    0,
  );
  const cash = round2(invested * randomBetween(rng, 0.04, 0.18));
  const dividends = buildDividends(positions, rng, today);
  const dividendTotal = dividends.reduce((total, entry) => total + entry.amount, 0);

  return {
    positions,
    dividends,
    cash,
    // Cash on hand today = funded + dividends received − everything deployed.
    fundedAmount: round2(invested + cash - dividendTotal),
  };
}

module.exports = { generatePortfolio, selectPortfolioSymbols };
