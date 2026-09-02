/**
 * What a virtual user does, and how often.
 *
 * Each activity is a short journey rather than a single request, because that is how
 * the API is actually used: nobody fetches an instrument without then fetching its
 * chart. Journeys carry their own short pauses so the requests inside one arrive
 * spread out, the way a page's follow-up calls do.
 *
 * Weights are relative, not percentages, so adding an activity does not require
 * renormalising the rest. Only trading's weight is configurable — everything else is
 * a shape of traffic rather than a knob anyone needs.
 */
import { config } from './config.js';
import * as api from './api.js';
import { buildIntel } from './intel.js';
import { metrics } from './metrics.js';
import { pick, pickWeighted, randomInt } from './random.js';

const HISTORY_RANGES = ['1D', '1D', '1D', '5D', '1M', '3M', '1Y'];
const EQUITY_RANGES = ['1M', '3M', '3M', '6M', '1Y', 'ALL'];
const SORTS = ['symbol', 'name', 'price', 'changePercent', 'volume', 'marketCapB'];
// Prefixes of the fictional issuers' names, plus a couple that match nothing —
// a search with no results is a real thing users do and a different query plan.
const SEARCHES = ['nova', 'atl', 'cap', 'tech', 'gro', 'meri', 'zz', 'qqq'];

/**
 * The instrument universe, as last seen. Replaced wholesale on every listing rather
 * than merged into, so this stays 25 entries for the life of the process instead of
 * accumulating every symbol ever returned.
 */
let universe = [];
const rememberUniverse = (list) => {
  if (Array.isArray(list) && list.length > 0) {
    universe = list.map((quote) => quote.symbol);
  }
};

/**
 * Set if the API answers 404 to POST /api/orders — an older build without order
 * entry. Trading then stops for the rest of the run instead of every user
 * rediscovering it every few minutes.
 */
let tradingUnavailable = false;
export const tradingIsAvailable = () => config.trading.enabled && !tradingUnavailable;

async function browseMarkets(ctx) {
  const listing = await ctx.step(
    api.instruments(ctx.token, {
      sort: pick(ctx.rng, SORTS),
      order: ctx.rng() < 0.5 ? 'asc' : 'desc',
    }),
  );
  rememberUniverse(listing.body?.instruments);

  await ctx.pause(400, 2500);
  if (ctx.rng() < 0.5) await ctx.step(api.movers(ctx.token));
  else await ctx.step(api.sectors(ctx.token));
}

async function searchAndFilter(ctx) {
  const listing = await ctx.step(
    api.instruments(ctx.token, { search: pick(ctx.rng, SEARCHES), limit: randomInt(ctx.rng, 5, 25) }),
  );
  rememberUniverse(listing.body?.instruments);

  await ctx.pause(600, 3000);
  const sectors = await ctx.step(api.sectors(ctx.token));
  const sector = sectors.body?.sectors?.length ? pick(ctx.rng, sectors.body.sectors) : '';
  await ctx.pause(300, 1500);
  await ctx.step(api.instruments(ctx.token, { sector, sort: 'changePercent', order: 'desc' }));
}

/** Open a name and look at its chart, sometimes flipping to a second range. */
async function openInstrument(ctx) {
  const symbol = await ctx.symbol();
  if (!symbol) return;

  await ctx.step(api.instrument(ctx.token, symbol));
  await ctx.pause(300, 1800);
  await ctx.step(api.instrumentHistory(ctx.token, symbol, pick(ctx.rng, HISTORY_RANGES)));

  if (ctx.rng() < 0.4) {
    await ctx.pause(800, 4000);
    await ctx.step(api.instrumentHistory(ctx.token, symbol, pick(ctx.rng, HISTORY_RANGES)));
  }
}

async function checkPortfolio(ctx) {
  const result = await ctx.step(api.portfolio(ctx.token));
  ctx.rememberPortfolio(result.body);

  if (ctx.rng() < 0.55) {
    await ctx.pause(500, 2500);
    await ctx.step(api.allocation(ctx.token));
  }
}

async function reviewPerformance(ctx) {
  await ctx.step(api.portfolioHistory(ctx.token, pick(ctx.rng, EQUITY_RANGES)));
  if (ctx.rng() < 0.35) {
    await ctx.pause(700, 3000);
    await ctx.step(api.portfolioHistory(ctx.token, pick(ctx.rng, EQUITY_RANGES)));
  }
}

async function reviewActivity(ctx) {
  await ctx.step(api.transactions(ctx.token, randomInt(ctx.rng, 10, 100)));
}

async function checkAllocation(ctx) {
  await ctx.step(api.allocation(ctx.token));
}

/** The one public endpoint — worth exercising without a token, as the login page does. */
async function checkMarketStatus(ctx) {
  await ctx.step(api.marketStatus());
}

/**
 * Look at the account, then buy or sell a market order.
 *
 * Sizing exists to keep the run going for weeks rather than to be realistic: a buy
 * takes at most LOADGEN_MAX_TRADE_NOTIONAL_PCT of available cash, and a sell takes a
 * slice of one holding. Without a cap, accounts spend themselves flat within the
 * hour and every subsequent order is a 422 — technically still load, but it stops
 * exercising the write path.
 */
async function trade(ctx) {
  if (!tradingIsAvailable()) return;

  const snapshot = await ctx.step(api.portfolio(ctx.token));
  ctx.rememberPortfolio(snapshot.body);
  const positions = snapshot.body?.positions ?? [];
  const cash = snapshot.body?.summary?.cash ?? 0;

  await ctx.pause(500, 3000);

  const wantsToSell = ctx.rng() < config.trading.sellProbability;
  let order = null;

  if (wantsToSell && positions.length > 0) {
    order = sellOrder(ctx, positions);
  } else {
    // An account with no spare cash falls back to selling, which is what keeps the
    // write path exercised once the roster has been buying for a few hours.
    order = await buyOrder(ctx, cash);
    if (!order && positions.length > 0) order = sellOrder(ctx, positions);
  }

  // Nothing affordable and nothing to sell. Not a failure — the next activity will
  // find the account in a different state.
  if (!order) return;

  const result = await ctx.step(api.placeOrder(ctx.token, order), { tolerate: [404] });

  if (result.status === 404 && result.body?.error?.code === 'not_found') {
    tradingUnavailable = true;
    console.warn(
      `[${config.serviceName}] POST /api/orders is not available on this API — trading disabled ` +
        'for the rest of the run; read activities continue.',
    );
    return;
  }

  metrics.countTrade({ filled: result.ok });
}

function sellOrder(ctx, positions) {
  const position = pick(ctx.rng, positions);
  // Up to a third of the holding, at least one share.
  const quantity = Math.max(1, randomInt(ctx.rng, 1, Math.ceil(position.quantity / 3)));
  return { symbol: position.symbol, side: 'SELL', quantity: Math.min(quantity, position.quantity) };
}

async function buyOrder(ctx, cash) {
  const symbol = await ctx.symbol();
  if (!symbol) return null;

  const quote = await ctx.step(api.instrument(ctx.token, symbol));
  const price = quote.body?.price;
  if (!(price > 0)) return null;

  const budget = cash * (config.trading.maxNotionalPercent / 100);
  const affordable = Math.floor(budget / price);
  if (affordable < 1) return null;

  return { symbol, side: 'BUY', quantity: randomInt(ctx.rng, 1, affordable) };
}

/**
 * Set if the market-intel service answers 404 to POST /intel — an older build, or a
 * stack where the `intel` profile is not running behind something that still routes.
 * Submissions then stop for the rest of the run rather than every user rediscovering
 * it every few minutes, exactly as trading does.
 */
let intelUnavailable = false;
export const intelIsAvailable = () => Boolean(config.intel.baseUrl) && !intelUnavailable;

/**
 * Submit a piece of market intelligence, and sometimes watch it being processed.
 *
 * This is the only activity that talks to a service other than the trading API, and
 * the only one that uploads bytes. It is in the same weighted table as the rest so
 * that intel traffic is a share of one roster's attention rather than a second load
 * pattern layered on top — the point is a realistic mix, and a separate uncoordinated
 * loop would make the two services' load profiles independent in a way real users are
 * not.
 */
async function submitIntel(ctx) {
  if (!intelIsAvailable()) return;

  const file = buildIntel(ctx.rng, config.intel);
  const result = await ctx.step(api.submitIntel(file), { tolerate: [404] });

  if (result.status === 404) {
    intelUnavailable = true;
    console.warn(
      `[${config.serviceName}] POST /intel is not available at ${config.intel.baseUrl} — ` +
        'intel submissions disabled for the rest of the run; everything else continues.',
    );
    return;
  }

  metrics.countIntel({ accepted: result.ok, kind: file.kind, bytes: file.body.length });

  // 413 means the generator built something bigger than the service accepts. Nothing
  // was queued, so there is nothing to poll.
  if (!result.ok) return;

  const intelId = result.body?.intelId;
  if (!intelId || ctx.rng() >= config.intel.pollProbability) return;

  // Poll the way a UI with a progress spinner would: a bounded number of times, then
  // give up and move on. Processing takes seconds for a large file, so some of these
  // legitimately end while the job is still running — that is the wait being real,
  // not a failure.
  for (let attempt = 0; attempt < config.intel.pollAttempts; attempt += 1) {
    // Unshaped: the poll interval imitates a progress spinner, and a spinner does not
    // tick faster because the market is busy.
    await ctx.pause(config.intel.pollIntervalMs, config.intel.pollIntervalMs * 2, { shaped: false });
    const status = await ctx.step(api.intelStatus(intelId));
    const state = status.body?.status;
    if (state === 'done' || state === 'failed') {
      metrics.countIntelOutcome(state);
      return;
    }
  }
  metrics.countIntelOutcome('pending');
}

export const activities = [
  { name: 'browse-markets', weight: 22, run: browseMarkets },
  { name: 'open-instrument', weight: 20, run: openInstrument },
  { name: 'check-portfolio', weight: 18, run: checkPortfolio },
  { name: 'search-filter', weight: 12, run: searchAndFilter },
  { name: 'review-performance', weight: 8, run: reviewPerformance },
  { name: 'review-activity', weight: 7, run: reviewActivity },
  { name: 'check-allocation', weight: 5, run: checkAllocation },
  { name: 'market-status', weight: 4, run: checkMarketStatus },
  { name: 'trade', weight: config.trading.enabled ? config.trading.weight : 0, run: trade },
  { name: 'submit-intel', weight: config.intel.baseUrl ? config.intel.weight : 0, run: submitIntel },
];

/**
 * Picks one activity, with the day's tilt applied to the base weights.
 *
 * The tilt multiplies rather than replaces, so the table above stays the single
 * statement of what the mix is and daypart.js only says how the day bends it. An
 * activity whose base weight is 0 — trading turned off, intel with no base URL — stays
 * unreachable no matter what the tilt says, which is what keeps "off" meaning off.
 *
 * @param {ReturnType<import('./daypart.js').daypart>} [day]
 */
export const chooseActivity = (rng, day) => {
  const tilt = day?.tilt;
  if (!tilt || Object.keys(tilt).length === 0) return pickWeighted(rng, activities);

  return pickWeighted(
    rng,
    activities.map((activity) => ({
      ...activity,
      weight: activity.weight * (tilt[activity.name] ?? 1),
    })),
  );
};

/** Falls back to the seeded universe when nothing has been listed yet this run. */
export const knownSymbols = () => universe;
