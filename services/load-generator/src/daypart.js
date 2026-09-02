/**
 * The shape of a trading day, as a multiplier on how often the roster acts.
 *
 * Offered load in this generator has always been a constant: N users, each pausing a
 * uniform 800–6000ms between activities. That produces a flat line, and a flat line is
 * the one thing production traffic never looks like. Every question worth asking of a
 * latency graph — is p90 rising, is this deploy worse, is that spike the platform or the
 * day — needs a baseline that moves on its own.
 *
 * So the rate is shaped by the exchange session, in real Eastern time:
 *
 *     04:00  ░░  pre-market wakes up
 *     09:30  ██  the open, ~2.6x the daily mean
 *     12:30  ▒▒  lunch, the quietest hour the market is open for
 *     15:45  ██  the close, nearly as busy as the open
 *     16:00  ░░  after-hours thins out
 *     20:00  ▁▁  overnight, ~0.15x
 *
 * Three things are layered to get there, in order:
 *
 *   1. **The curve** — piecewise-linear interpolation between the control points in
 *      `WEEKDAY_CURVE`. Weekends are scaled flat by `WEEKEND_FACTOR`; nobody trades.
 *   2. **Minute noise** — a small lognormal wobble, so the curve is not a visibly
 *      drawn spline. Real volume is noisy at every timescale.
 *   3. **Bursts** — a handful of minutes a day where the rate jumps 2–4x for one to
 *      three minutes. A headline hits the tape and everyone reloads at once. These are
 *      the outliers; without them the distribution has no tail and every anomaly
 *      detector pointed at it is being tested against a sine wave.
 *
 * Both the noise and the bursts are seeded from `LOADGEN_SEED` and the ET calendar day,
 * not `Math.random`, so the same seed replays the same day — including which minutes
 * burst. A traffic pattern nobody can reproduce is one nobody can debug against.
 *
 * The Eastern-time arithmetic is the same Intl-based approach as the trading API's
 * `src/market/clock.js`, duplicated for the same reason `random.js` is: these two
 * services build from separate directories with no shared context, and thirty lines of
 * date formatting is a cheaper duplicate than a workspace package coupling two images
 * that ship independently.
 */
import { config } from './config.js';
import { createRng, hashString } from './random.js';

const ET_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  hour12: false,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * Control points as `[minuteOfDay, factor]`, interpolated linearly between.
 *
 * The factors are relative to each other, not absolute: what matters is that the open is
 * ~3x lunch and ~12x the small hours. They are then divided by the curve's own mean (see
 * CURVE_MEAN) so a full weekday averages exactly 1.0 — which is what keeps the existing
 * LOADGEN_THINK_* defaults meaning what they always meant, and keeps this change about
 * the shape of a day's traffic rather than about how much of it there is.
 */
const WEEKDAY_CURVE = [
  [0, 0.15],          // 00:00  overnight
  [4 * 60, 0.22],     // 04:00  pre-market session opens
  [7 * 60, 0.48],     // 07:00  European close, US desks arriving
  [9 * 60, 1.15],     // 09:00  the half hour before the bell
  [9 * 60 + 30, 2.60], // 09:30  the open
  [10 * 60, 1.95],    // 10:00  first half hour worked through
  [11 * 60, 1.25],    // 11:00
  [12 * 60 + 30, 0.80], // 12:30 lunch, the quietest hour of the session
  [14 * 60, 0.95],    // 14:00  afternoon picks back up
  [15 * 60, 1.35],    // 15:00  the last hour
  [15 * 60 + 45, 2.30], // 15:45 the close
  [16 * 60, 1.60],    // 16:00  bell rings, positions get reviewed
  [17 * 60, 0.70],    // 17:00  after-hours thinning
  [20 * 60, 0.30],    // 20:00  after-hours session ends
  [24 * 60, 0.15],    // 24:00  back to overnight, matching minute 0
];

/** Weekends are not zero: overnight desks and this demo's own uptime both continue. */
const WEEKEND_FACTOR = 0.18;

/**
 * The curve's own time-weighted mean, computed once, divided out of every reading.
 *
 * Without this, adding the curve would also change the total: the shipped control points
 * average 0.71, so switching shaping on would have quietly cut a day's offered load by
 * nearly a third. This change is meant to be about *shape*. A demo box whose absolute
 * request volume moved because the traffic pattern got more interesting is a box where
 * every before-and-after comparison across the change is confounded.
 *
 * Derived rather than a literal so the property survives editing the table: move a
 * control point and the mean re-normalises itself.
 */
const CURVE_MEAN = (() => {
  let total = 0;
  for (let minute = 0; minute < 1440; minute += 1) total += rawCurveFactor(minute);
  return total / 1440;
})();

/**
 * Named windows, used for the activity tilt rather than for the rate.
 *
 * The rate curve above is continuous because volume is; what a user *does* changes in
 * steps, because it follows what is possible. Order entry outside the regular session
 * is a different decision from order entry at the open, not a fractionally less likely
 * one.
 */
function windowFor(minuteOfDay, isWeekend) {
  if (isWeekend) return 'weekend';
  if (minuteOfDay < 4 * 60) return 'overnight';
  if (minuteOfDay < 9 * 60 + 30) return 'pre-market';
  if (minuteOfDay < 11 * 60) return 'open';
  if (minuteOfDay < 15 * 60) return 'midday';
  if (minuteOfDay < 16 * 60) return 'close';
  if (minuteOfDay < 20 * 60) return 'after-hours';
  return 'overnight';
}

const LABELS = {
  overnight: 'overnight',
  'pre-market': 'pre-market',
  open: 'the open',
  midday: 'midday',
  close: 'the close',
  'after-hours': 'after hours',
  weekend: 'weekend',
};

/**
 * Per-activity weight multipliers by window. Missing entries mean 1.0 — the default is
 * "this activity is not time-of-day sensitive", which is true of most browsing.
 *
 * The two that matter are the two the demo's downstream services hang off. Trading is
 * concentrated at the open and the close, which is where real order flow is, and that
 * concentration is what puts a diurnal shape on the fraud service's invocation count as
 * well — every fill screens. Intel submissions run the other way: research is published
 * before the bell and digested after it, so the queue's busiest hours are deliberately
 * *not* the trading API's. Two services whose peaks coincide are indistinguishable in a
 * graph from one service counted twice.
 */
const ACTIVITY_TILT = {
  overnight: { trade: 0.40, 'submit-intel': 1.1, 'check-portfolio': 0.7, 'browse-markets': 0.8 },
  'pre-market': { trade: 0.55, 'submit-intel': 2.4, 'browse-markets': 1.35, 'review-activity': 0.7 },
  open: { trade: 2.30, 'submit-intel': 0.45, 'review-performance': 0.6, 'check-allocation': 0.7 },
  midday: { trade: 0.85, 'submit-intel': 1.0 },
  close: { trade: 2.45, 'submit-intel': 0.55, 'review-performance': 0.8 },
  'after-hours': { trade: 0.50, 'submit-intel': 2.0, 'review-performance': 1.9, 'check-portfolio': 1.4 },
  weekend: { trade: 0.35, 'submit-intel': 1.3, 'review-performance': 1.6, 'browse-markets': 0.7 },
};

/*
 * A note on how low those troughs are allowed to go, because it is a real trade-off and
 * not a styling choice. The rate curve already thins overnight traffic by ~12x; a trade
 * tilt of 0.25 on top of that took order flow to 1/100th of its daily mean, which is
 * arguably realistic and operationally awful — typical degradation detectors gate on a
 * minimum invocation count in *both* the current and the reference window, so a deploy
 * made at 03:00 would have nothing to compare. The floors above keep the combined
 * dynamic range near 50x: unmistakable in a graph, still enough order flow at every hour
 * of the day for a detector to have an opinion.
 */

/** ET calendar fields, plus the day key the seeded noise is derived from. */
function easternTime(now) {
  const lookup = Object.fromEntries(
    ET_FORMATTER.formatToParts(now).map((part) => [part.type, part.value]),
  );
  // hour12: false renders midnight as "24" in some ICU versions, as clock.js notes.
  const hour = Number.parseInt(lookup.hour, 10) % 24;
  const minute = Number.parseInt(lookup.minute, 10);
  return {
    weekday: lookup.weekday,
    dayKey: `${lookup.year}-${lookup.month}-${lookup.day}`,
    minuteOfDay: hour * 60 + minute,
  };
}

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

/** The curve, scaled so a full weekday averages 1.0 — see CURVE_MEAN. */
const curveFactor = (minuteOfDay) => rawCurveFactor(minuteOfDay) / CURVE_MEAN;

/**
 * A generator for one specific ET minute, stable across processes and restarts.
 *
 * Keyed by day *and* minute rather than advanced from a single per-day stream, so the
 * factor for 14:32 does not depend on how many times the process has asked about
 * earlier minutes — two containers started an hour apart must agree on the shape.
 */
const minuteRng = (dayKey, minute, salt) =>
  createRng((config.seed ^ hashString(`${salt}:${dayKey}:${minute}`)) >>> 0);

/** Box–Muller, matching the trading API's `gaussian`. */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Whether a burst is in progress, and how big.
 *
 * A burst is decided by the minute it *starts*, then applies for its own length, so it
 * has to be looked for in the recent past rather than only at the current minute —
 * otherwise every burst is exactly one minute long and the tail has no width. The
 * search window is the longest a burst can last.
 */
function burstFactor(dayKey, minuteOfDay, shape) {
  if (shape.burstProbability <= 0) return { factor: 1, active: false };

  for (let back = 0; back < shape.burstMaxMinutes; back += 1) {
    const startMinute = minuteOfDay - back;
    if (startMinute < 0) break;

    const rng = minuteRng(dayKey, startMinute, 'burst');
    if (rng() >= shape.burstProbability) continue;

    // Length first, so a burst that has already ended is not mistaken for one running.
    const lengthMinutes = 1 + Math.floor(rng() * shape.burstMaxMinutes);
    if (back >= lengthMinutes) continue;

    const magnitude = 2 + rng() * Math.max(shape.burstMax - 2, 0);
    // Bursts decay across their own length rather than ending in a cliff.
    const decay = lengthMinutes === 1 ? 1 : 1 - (back / lengthMinutes) * 0.5;
    return { factor: 1 + (magnitude - 1) * decay, active: true };
  }

  return { factor: 1, active: false };
}

/**
 * The state of the day right now.
 *
 * @param {Date} [now]
 * @returns {{factor: number, window: string, label: string, bursting: boolean,
 *   minuteOfDay: number, tilt: Record<string, number>}} `factor` multiplies the rate:
 *   2.0 means the roster acts twice as often as its configured think time, which is
 *   applied as a *division* of the pause. `tilt` multiplies activity weights.
 */
export function daypart(now = new Date()) {
  const shape = config.dayShape;
  const { weekday, dayKey, minuteOfDay } = easternTime(now);
  const isWeekend = WEEKEND.has(weekday);
  const window = windowFor(minuteOfDay, isWeekend);

  if (!shape.enabled) {
    return { factor: 1, window, label: `${LABELS[window]} (shaping off)`, bursting: false, minuteOfDay, tilt: {} };
  }

  const base = curveFactor(minuteOfDay) * (isWeekend ? WEEKEND_FACTOR : 1);

  // Lognormal so the noise is multiplicative and cannot drive the rate negative, and
  // so its own tail leans the way traffic does — up.
  const noise =
    shape.noiseSigma > 0 ? Math.exp(gaussian(minuteRng(dayKey, minuteOfDay, 'noise')) * shape.noiseSigma) : 1;

  const burst = burstFactor(dayKey, minuteOfDay, shape);
  const factor = Math.min(Math.max(base * noise * burst.factor, shape.minFactor), shape.maxFactor);

  return {
    factor,
    window,
    label: burst.active ? `${LABELS[window]}, burst` : LABELS[window],
    bursting: burst.active,
    minuteOfDay,
    tilt: shape.tilt ? (ACTIVITY_TILT[window] ?? {}) : {},
  };
}

/**
 * Scales a pause by the current rate.
 *
 * Dividing is the point: the roster size is fixed, so the only lever on arrival rate is
 * how long each user waits, and acting 2.6x as often means pausing for 1/2.6 as long.
 * Clamped at both ends — a burst must not turn think time into a tight loop, and
 * overnight must not park a user for so long that the reporter's window sees nothing at
 * all and the container's own healthcheck calls it wedged.
 */
export function shapePause(ms, factor) {
  return Math.max(Math.round(ms / factor), config.dayShape.minPauseMs);
}

/** One block for the boot log, so the shape is in the container's own logs. */
export function describeDayShape() {
  const shape = config.dayShape;
  if (!shape.enabled) return 'off (flat rate, LOADGEN_DAY_SHAPE=false)';

  const sample = [0, 4 * 60, 9 * 60 + 30, 12 * 60 + 30, 15 * 60 + 45, 18 * 60]
    .map((minute) => {
      const hour = String(Math.floor(minute / 60)).padStart(2, '0');
      return `${hour}:${String(minute % 60).padStart(2, '0')} ${curveFactor(minute).toFixed(2)}x`;
    })
    .join('  ');
  return (
    `ET session curve, ±${(shape.noiseSigma * 100).toFixed(0)}% minute noise, ` +
    `bursts ${(shape.burstProbability * 100).toFixed(1)}%/min up to ${shape.burstMax}x` +
    `${shape.tilt ? ', activity tilt on' : ''}\n                  ${sample}`
  );
}
