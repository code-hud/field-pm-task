/**
 * How busy the platform is right now, as a multiplier.
 *
 * The fourth copy of the same fifteen numbers — the load generator shapes its arrival
 * rate with them, the fraud service and the market-intel worker shape their service
 * times with them, and this one shapes the cost of a fill. Duplicated for the reason
 * `random.js` is duplicated between this service and the generator: four services, three
 * languages, four build contexts, and nothing worth creating to hold fifteen numbers.
 *
 * The Eastern-time arithmetic reuses `src/market/clock.js`, which already resolves ET
 * with DST via Intl and is the authority on what session the exchange is in. This module
 * only adds the curve, so there is exactly one place in this service that knows what time
 * it is in New York.
 */
const { easternTime } = require('../market/clock.js');
const { hashString, createRng, gaussian } = require('./random.js');

/** `[minuteOfDay, factor]`, interpolated linearly. Identical to the other three copies. */
const WEEKDAY_CURVE = [
  [0, 0.15],            // 00:00  overnight
  [4 * 60, 0.22],       // 04:00  pre-market session opens
  [7 * 60, 0.48],       // 07:00  European close, US desks arriving
  [9 * 60, 1.15],       // 09:00  the half hour before the bell
  [9 * 60 + 30, 2.60],  // 09:30  the open
  [10 * 60, 1.95],      // 10:00  first half hour worked through
  [11 * 60, 1.25],      // 11:00
  [12 * 60 + 30, 0.80], // 12:30  lunch, the quietest hour of the session
  [14 * 60, 0.95],      // 14:00  afternoon picks back up
  [15 * 60, 1.35],      // 15:00  the last hour
  [15 * 60 + 45, 2.30], // 15:45  the close
  [16 * 60, 1.60],      // 16:00  bell rings, positions get reviewed
  [17 * 60, 0.70],      // 17:00  after-hours thinning
  [20 * 60, 0.30],      // 20:00  after-hours session ends
  [24 * 60, 0.15],      // 24:00  back to overnight, matching minute 0
];

const WEEKEND_FACTOR = 0.18;

/** Linear interpolation across the control points, before normalisation. */
function rawCurveFactor(minuteOfDay) {
  for (let i = 1; i < WEEKDAY_CURVE.length; i += 1) {
    const [atMinute, factor] = WEEKDAY_CURVE[i];
    if (minuteOfDay <= atMinute) {
      const [prevMinute, prevFactor] = WEEKDAY_CURVE[i - 1];
      const span = atMinute - prevMinute;
      const progress = span === 0 ? 0 : (minuteOfDay - prevMinute) / span;
      return prevFactor + (factor - prevFactor) * progress;
    }
  }
  return WEEKDAY_CURVE.at(-1)[1];
}

/**
 * The curve's own time-weighted mean, divided out so a full weekday averages 1.0.
 *
 * Derived rather than written down, so moving a control point re-normalises the curve
 * instead of silently changing how much simulated latency a day contains in total.
 */
const CURVE_MEAN = (() => {
  let total = 0;
  for (let minute = 0; minute < 1440; minute += 1) total += rawCurveFactor(minute);
  return total / 1440;
})();

/**
 * How busy the platform is, relative to its own daily mean.
 *
 * 1.0 is an average minute, ~3.8 is the opening bell, ~0.2 is the small hours. Weekends
 * are the same curve at `WEEKEND_FACTOR`.
 */
function sessionFactor(now = new Date()) {
  const { weekday, minuteOfDay } = easternTime(now);
  const factor = rawCurveFactor(minuteOfDay) / CURVE_MEAN;
  // clock.js maps Sunday to 0 and Saturday to 6.
  return weekday === 0 || weekday === 6 ? factor * WEEKEND_FACTOR : factor;
}

/** The ET minute, as the string a per-request seed is derived from. */
function minuteKey(now = new Date()) {
  const { hour, minute } = easternTime(now);
  // The date is not in the key: a per-minute seed only has to be stable *within* a
  // minute, and every caller salts it with something request-specific anyway. Two orders
  // a day apart differing is not a property anything needs.
  return `${hour}:${minute}`;
}

/**
 * A lognormal draw with an occasional flat stall, the shape used for every simulated
 * service time in this demo.
 *
 * Multiplicative for the body of the distribution, because service times are — a
 * four-second job varies by a second, a 200ms job does not. Flat for the tail, because a
 * real outlier is a GC pause or a retried call and costs what it costs regardless of the
 * work it interrupted.
 *
 * @param {string} seedKey stable per (thing being measured, ET minute), so the same
 *   request costs the same twice within a minute and is free to differ in the next.
 * @param {{baseMs: number, congestion: number, sigma: number, stallProbability: number,
 *   stallMinMs: number, stallMaxMs: number, maxMs: number, dayShape: boolean}} shape
 * @returns {{ms: number, factor: number, stalled: boolean}}
 */
function simulatedCost(seedKey, shape, now = new Date()) {
  const day = shape.dayShape === false ? 1 : sessionFactor(now);
  // Floored: a congestion multiplier that can reach zero is a bug waiting for someone to
  // set congestion above 1. Overnight is faster, not free.
  const congestion = Math.max(1 + shape.congestion * (day - 1), 0.2);

  const rng = createRng(hashString(`${seedKey}:${minuteKey(now)}`));
  const spread = shape.sigma > 0 ? Math.exp(gaussian(rng) * shape.sigma) : 1;

  const factor = congestion * spread;
  let ms = shape.baseMs * factor;

  const stalled = shape.stallProbability > 0 && rng() < shape.stallProbability;
  if (stalled) {
    ms += shape.stallMinMs + rng() * Math.max(shape.stallMaxMs - shape.stallMinMs, 0);
  }

  return { ms: Math.max(0, Math.min(Math.round(ms), shape.maxMs)), factor, stalled };
}

module.exports = { sessionFactor, minuteKey, simulatedCost, CURVE_MEAN };
