/**
 * The session curve and the simulated-cost model, as arithmetic.
 *
 * No database and no HTTP: both functions take their moment as an argument, which is the
 * only reason "the open costs more than 03:00" is testable at all — a version that read
 * the wall clock could only be tested at 09:30.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { config } = require('../src/config/index.js');
const { sessionFactor, minuteKey, simulatedCost, CURVE_MEAN } = require('../src/lib/daypart.js');

// 2026-08-26 is a Wednesday, 2026-08-29 a Saturday. Both in EDT, so ET is UTC-4.
const et = (hour, minute = 0, day = 26) =>
  new Date(Date.UTC(2026, 7, day, hour + 4, minute));

const SHAPE = {
  enabled: true,
  dayShape: true,
  baseMs: 5,
  congestion: 0.6,
  sigma: 0.45,
  stallProbability: 0.008,
  stallMinMs: 80,
  stallMaxMs: 350,
  maxMs: 500,
};

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** The median cost across one ET hour, which is what the day factor moves. */
const medianOverHour = (hour, day = 26) =>
  median(Array.from({ length: 60 }, (_, m) => simulatedCost('a:MSFT:BUY:40', SHAPE, et(hour, m, day)).ms));

describe('the session curve', () => {
  it('averages 1.0 across a weekday, by construction', () => {
    // The normalisation is what keeps this a change to the *shape* of the demo's latency
    // rather than to how much of it there is. Asserted here so nobody can move a control
    // point and quietly raise the whole day's cost.
    const mean =
      Array.from({ length: 1440 }, (_, m) => sessionFactor(et(0, m))).reduce((a, b) => a + b, 0) / 1440;
    assert.ok(Math.abs(mean - 1) < 0.01, `weekday mean was ${mean.toFixed(4)}`);
  });

  it('peaks at the opening bell and troughs overnight', () => {
    assert.ok(sessionFactor(et(9, 30)) > 3.5);
    assert.ok(sessionFactor(et(3, 30)) < 0.4);
    assert.ok(sessionFactor(et(12, 30)) < sessionFactor(et(15, 45)));
  });

  it('is quieter at the weekend', () => {
    assert.ok(sessionFactor(et(14, 0, 29)) < sessionFactor(et(14, 0, 26)));
  });

  it('agrees with the other three copies of the curve', () => {
    // The same fifteen control points live in the load generator, the fraud service and
    // the intel worker. These are the values all four produce; if one copy is edited
    // without the others, this is where it shows up.
    assert.ok(Math.abs(CURVE_MEAN - 0.6876) < 0.0001, `curve mean was ${CURVE_MEAN}`);
    assert.ok(Math.abs(sessionFactor(et(9, 30)) - 3.782) < 0.01);
    assert.ok(Math.abs(sessionFactor(et(14, 0, 29)) - 0.249) < 0.01);
  });

  it('is continuous across midnight', () => {
    // The last control point matches the first, so 23:59 and 00:00 are neighbours rather
    // than a cliff.
    assert.ok(Math.abs(sessionFactor(et(23, 59)) - sessionFactor(et(0, 0))) < 0.02);
  });
});

describe('the simulated cost', () => {
  it('is the same twice within one minute', () => {
    // Keeps a retried request from looking like the source of the variance.
    const a = simulatedCost('a:MSFT:BUY:40', SHAPE, et(11, 17));
    const b = simulatedCost('a:MSFT:BUY:40', SHAPE, et(11, 17));
    assert.deepEqual(a, b);
  });

  it('differs between orders in the same minute', () => {
    const a = simulatedCost('a:MSFT:BUY:40', SHAPE, et(11, 17)).ms;
    const b = simulatedCost('a:NVDA:BUY:40', SHAPE, et(11, 17)).ms;
    assert.notEqual(a, b);
  });

  it('moves from minute to minute', () => {
    const seen = new Set(
      Array.from({ length: 20 }, (_, m) => simulatedCost('a:MSFT:BUY:40', SHAPE, et(11, m)).ms),
    );
    assert.ok(seen.size > 5, `only ${seen.size} distinct costs across 20 minutes`);
  });

  it('costs more at the open than in the small hours', () => {
    // Medians over a spread of minutes, not single samples: one unlucky lognormal draw
    // would otherwise fail this a few times a year and teach everyone to rerun CI.
    assert.ok(medianOverHour(9) > medianOverHour(3) * 2);
  });

  it('never exceeds its cap, at any hour', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      for (let minute = 0; minute < 60; minute += 3) {
        for (const quantity of [1, 40, 5000]) {
          const { ms } = simulatedCost(`a:MSFT:BUY:${quantity}`, SHAPE, et(hour, minute));
          assert.ok(ms <= SHAPE.maxMs, `${ms}ms at ${hour}:${minute}`);
        }
      }
    }
  });

  it('stays well under a typical alert floor even at its worst', () => {
    // The load-bearing assertion. `current_duration_min` on this account is 150ms, and
    // the point of the whole exercise is a baseline that moves visibly *without*
    // manufacturing degradation alerts. The cap is what guarantees it; this states the
    // number so a future change to `maxMs` has to argue with it.
    assert.ok(SHAPE.maxMs <= 500);
    assert.ok(medianOverHour(9) < 30, `median at the open was ${medianOverHour(9)}ms`);
  });

  it('stalls occasionally and visibly', () => {
    const samples = [];
    for (let minute = 0; minute < 60; minute += 1) {
      for (let quantity = 1; quantity <= 60; quantity += 1) {
        samples.push(simulatedCost(`a:MSFT:BUY:${quantity}`, SHAPE, et(11, minute)));
      }
    }
    const stalled = samples.filter((sample) => sample.stalled);
    const rate = stalled.length / samples.length;

    assert.ok(stalled.length > 0, 'no stall in 3600 samples — the tail is unreachable');
    // Wide bounds: the order of magnitude of the configured probability, not the draw.
    assert.ok(rate > SHAPE.stallProbability * 0.25 && rate < SHAPE.stallProbability * 4, `rate ${rate}`);
    assert.ok(Math.min(...stalled.map((s) => s.ms)) >= SHAPE.stallMinMs);
  });

  it('has a floor on congestion, so overnight is faster rather than free', () => {
    const greedy = { ...SHAPE, congestion: 3, sigma: 0 };
    assert.ok(simulatedCost('a:MSFT:BUY:40', greedy, et(3, 30)).ms > 0);
  });

  it('collapses to the base cost with the day shape off', () => {
    const flat = { ...SHAPE, dayShape: false, sigma: 0, stallProbability: 0 };
    assert.equal(simulatedCost('a:MSFT:BUY:40', flat, et(9, 30)).ms, SHAPE.baseMs);
    assert.equal(simulatedCost('a:MSFT:BUY:40', flat, et(3, 30)).ms, SHAPE.baseMs);
  });

  it('is off in the test suite, so orders do not spend it', () => {
    assert.equal(config.orders.latency.enabled, false);
  });

  it('keys minutes without the date', () => {
    assert.equal(minuteKey(et(9, 30)), minuteKey(et(9, 30, 29)));
    assert.notEqual(minuteKey(et(9, 30)), minuteKey(et(9, 31)));
  });
});
