# load-generator

Synthetic traffic for the Heads Up Financial demo. A roster of virtual users signs in,
browses the market, opens charts, checks portfolios, places market orders, and uploads
market intelligence files — with think time between actions, and backoff instead of a
crash when a service goes away.

It is a client. No port, no database, no state that outlives the process, and no
dependencies: Node 22's built-in `fetch` is the whole HTTP stack. That last constraint is
load-bearing rather than decorative — it is why the synthetic PDFs and PNGs in `intel.js`
are assembled byte by byte instead of with a library.

It drives two services: the trading API, and — when `LOADGEN_INTEL_BASE_URL` is set — the
market intelligence pipeline.

```bash
make loadgen                        # against http://localhost:4000
make loadgen-up                     # as a container beside the compose stack
make loadgen-logs                   # follow its summaries
make loadgen-down                   # stop just the generator
```

`make up` does **not** start it — the compose service sits behind the `loadgen`
profile, so the demo never grows a traffic generator by accident.

## Running it

**On a laptop, against a local API.** `make dev` or `make dev-api` in one terminal,
then:

```bash
cd services/load-generator
LOADGEN_USERS=8 LOADGEN_TRADE_WEIGHT=15 npm start
```

**As a container, against the stack.** The compose service reaches the API over the
compose network, exactly as the browser does through nginx:

```bash
docker compose --profile loadgen up -d load-generator
docker logs -f financial-platform-demo-load-generator-1
```

**Against the deployed demo**, or anything else with the same contract:

```bash
LOADGEN_BASE_URL=http://localhost:4000 LOADGEN_USERS=4 npm start
```

Stop it with Ctrl-C or `docker stop`. Either signal drains in-flight requests, prints
a final summary, and exits 0.

## What the users do

Each activity is a short journey rather than one request, because that is how the API
is really used — nobody opens an instrument without then loading its chart. Weights
are relative:

| | weight | |
|---|---|---|
| `browse-markets` | 22 | list quotes with a random sort, then movers or sectors |
| `open-instrument` | 20 | a quote, its chart, sometimes a second range |
| `check-portfolio` | 18 | the portfolio, often the allocation too |
| `search-filter` | 12 | a search, then a sector filter |
| `review-performance` | 8 | the equity curve at one or two ranges |
| `review-activity` | 7 | the transaction ledger |
| `check-allocation` | 5 | allocation on its own |
| `market-status` | 4 | the one public endpoint, as the login page calls it |
| `trade` | `LOADGEN_TRADE_WEIGHT` | read the account, then buy or sell at market |

Buys are capped at `LOADGEN_MAX_TRADE_NOTIONAL_PCT` of available cash, and sells take
up to a third of one holding. That cap is what keeps a run going for weeks: without
it, accounts spend themselves flat inside an hour and every later order is a 422,
which is still traffic but stops exercising the write path.

If the API answers 404 to `POST /api/orders` — an older build with no order entry —
trading switches off for the rest of the run, once, with a warning. Read activities
carry on.

## The shape of a day

The rate is not flat. It follows an Eastern-time exchange session, because a flat line
is the one thing production traffic never looks like — and every question worth asking
of a latency graph ("is p90 rising, is this deploy worse, is that spike us or the day")
needs a baseline that moves on its own.

```
             00:00  ▁▁                      0.22x  overnight
             04:00  ▂▂                      0.32x  pre-market opens
             07:00  ▄▄                      0.70x
             09:30  ████████████████████    3.78x  the open
             10:30  ██████████              2.1x
             12:30  ██████                  1.16x  lunch, the session's quietest hour
             15:45  ██████████████████      3.35x  the close
             17:00  ████                    1.0x   after-hours thinning
             20:00  ▂▂                      0.43x
```

Three layers, in `src/daypart.js`:

1. **The curve** — piecewise-linear between the control points above, then divided by
   its own mean so a full weekday averages exactly `1.0x`. That normalisation is
   deliberate: without it, switching shaping on would also have cut a day's total
   offered load by ~29%, and this is meant to be a change to the shape of the traffic,
   not to how much of it there is. Weekends are the same curve at `0.18x`.
2. **Minute noise** — a ±12% lognormal wobble, so the curve is not a visibly drawn
   spline.
3. **Bursts** — roughly eight or nine minutes a day jump to 2–4x for one to three
   minutes and decay, the way a headline hitting the tape looks. These are the tail: an
   arrival distribution with no outliers is a sine wave, and every anomaly detector
   pointed at one is being tested against nothing.

Composed, that is about a **32x spread** between the quietest minute and the busiest,
clamped to `[0.08x, 6x]`. The floor matters — it keeps overnight traffic non-zero, so
the report window and the container healthcheck both still see requests at 03:00.

The factor is applied by *dividing* think time: the roster is a fixed size, so the only
lever on arrival rate is how long each user waits. At the open they wait a third as long
as configured; at 03:00, four times as long. Waits that are not think time are exempt —
the intel poll interval imitates a progress spinner, and a spinner does not tick faster
because the market is busy.

### The mix moves too

The rate shapes every endpoint at once, which on its own would give every endpoint the
same curve — indistinguishable in a dashboard from one endpoint counted several times.
So the activity weights are also tilted by session window (`LOADGEN_DAY_TILT=false`
turns just this part off):

| window | `trade` | `submit-intel` | also |
|---|---|---|---|
| overnight (20:00–04:00) | ×0.40 | ×1.1 | browsing and portfolio checks thin out |
| pre-market (04:00–09:30) | ×0.55 | ×2.4 | more browsing |
| the open (09:30–11:00) | ×2.30 | ×0.45 | less reviewing; nobody reads charts at the bell |
| midday (11:00–15:00) | ×0.85 | ×1.0 | |
| the close (15:00–16:00) | ×2.45 | ×0.55 | |
| after hours (16:00–20:00) | ×0.50 | ×2.0 | performance review ×1.9 |
| weekend | ×0.35 | ×1.3 | performance review ×1.6 |

Order flow concentrates at the open and the close, which is also what puts a diurnal
shape on the **fraud service's** invocation count, since every fill screens. Intel
submissions run the other way — research is published before the bell and digested
after it — so the **queue's** busiest hours are deliberately *not* the trading API's.
Multiplied through the rate curve, that comes out as roughly:

| | peak | trough | busiest hour |
|---|---|---|---|
| orders + fraud checks | 6.0x | 0.09x | 15:00 ET |
| intel queue | 3.0x | 0.22x | 09:00 ET |
| browsing | 3.3x | 0.19x | 09:00 ET |

Those troughs are floors, not the realistic values. The rate curve already thins
overnight by ~12x, and a `trade` tilt of 0.25 on top took order flow to 1/100th of its
daily mean — arguably realistic and operationally awful, because typical degradation
detectors gate on a minimum invocation count in *both* the current and the reference
window, so a deploy made at 03:00 would have nothing to compare against. The floors keep
the combined range near 65x: unmistakable in a graph, still enough order flow at every
hour for a detector to have an opinion.

Everything above is seeded from `LOADGEN_SEED` and the ET calendar day — including which
minutes burst. The same seed replays the same day. A traffic pattern nobody can reproduce
is one nobody can debug against.

## Configuration

Everything is an environment variable, and every one has a working default.

| | default | |
|---|---|---|
| `LOADGEN_BASE_URL` | `http://localhost:4000` | API root, no trailing slash |
| `LOADGEN_USERS` | `12` | roster size, drawn from a built-in name list |
| `LOADGEN_USERNAMES` | — | comma-separated roster; overrides `LOADGEN_USERS` |
| `LOADGEN_PASSWORD` | `loadgen-demo` | any non-blank string works |
| `LOADGEN_THINK_MIN_MS` · `_MAX_MS` | `800` · `6000` | pause between activities |
| `LOADGEN_CONCURRENCY` | user count | ceiling on requests in flight |
| `LOADGEN_RAMP_MS` | `10000` | window the first sign-ins are spread over |
| `LOADGEN_TRADING` | `true` | off disables trading entirely |
| `LOADGEN_TRADE_WEIGHT` | `6` | weight of trading in the mix above |
| `LOADGEN_SELL_PROBABILITY` | `0.45` | how often a trade is a sell |
| `LOADGEN_MAX_TRADE_NOTIONAL_PCT` | `4` | ceiling on one buy, as a share of cash |
| `LOADGEN_REQUEST_TIMEOUT_MS` | `15000` | per-request deadline |
| `LOADGEN_BACKOFF_MIN_MS` · `_MAX_MS` | `500` · `30000` | retry delay bounds |
| `LOADGEN_DURATION_SEC` | `0` | `0` runs until stopped |
| `LOADGEN_REPORT_INTERVAL_MS` | `30000` | how often the summary prints |
| `LOADGEN_ERROR_LOG_INTERVAL_MS` | `10000` | throttle on individual failure lines |
| `LOADGEN_SEED` | `20260803` | same seed, same run |
| `LOADGEN_DAY_SHAPE` | `true` | `false` gives back a flat rate |
| `LOADGEN_DAY_TILT` | `true` | `false` keeps the rate curve but flattens the activity mix |
| `LOADGEN_DAY_NOISE_SIGMA` | `0.12` | per-minute lognormal wobble |
| `LOADGEN_DAY_BURST_PROBABILITY` | `0.006` | chance a burst starts in any given minute |
| `LOADGEN_DAY_BURST_MAX` | `4` | biggest burst multiplier |
| `LOADGEN_DAY_BURST_MAX_MINUTES` | `3` | longest a burst lasts |
| `LOADGEN_DAY_MIN_FACTOR` · `_MAX_FACTOR` | `0.08` · `6` | clamps on the composed factor |
| `LOADGEN_DAY_MIN_PAUSE_MS` | `120` | floor on a shaped pause |
| `LOADGEN_HEARTBEAT_FILE` | — | set in the image, for the healthcheck |

Offered load is `users ÷ (mean think time + mean journey time)`, roughly — and then
multiplied by the day factor, so those figures are the *daily mean* rather than the rate
at any given moment. Twelve users at the default think time is about 3 req/s averaged
over a day, nearer 11 at the open and under 1 overnight; sixteen users at 20–120ms is
about 21.
`LOADGEN_CONCURRENCY` is a guard rail, not the throttle — it stops a slow API from
turning queued activity into an open socket per user.

The seed picks the roster, every activity choice, every think time, and every trade
size. Two runs with the same seed against the same market issue the same requests in
the same order, which is what makes "it fell over after an hour" reproducible.

## Surviving things

The core requirement is that this runs for weeks without attention, so the interesting
parts are all about not dying.

**Nothing throws out of a user's loop.** `client.js` returns a result object for every
outcome rather than rejecting, so a forgotten `await` cannot become an unhandled
rejection. Above that, each user's loop catches everything — including bugs in this
generator — logs it, backs off, and starts the next iteration. `main.js` handles
`unhandledRejection` and `uncaughtException` by logging and continuing, because a
soak test that quits on its own bug in week three is worse than one that says so.

**Failures are classified, and only some of them are errors.** A 422 on an
unaffordable order is the API working correctly and is counted as `rejected`, not as
a failure; folding it into the error rate would make a healthy run look broken. A 401
is a session problem, not a failure of the endpoint that returned it — the user drops
its token and signs in again.

**Sessions are refreshed before they expire, not after.** The JWT's `exp` is read
(not verified — this is a client) and the token is replaced a minute early. Waiting
for the 401 would work, but every token is minted inside the same ramp window, so
they would all expire together and the whole roster would re-login as one burst.

**Backoff is exponential with full jitter, capped.** The delay is uniform over
`[0, capped exponential)`. When an API comes back after being down, every user's
backoff has converged on the cap; without jitter they would all return in the same
tick and hit a cold process together.

**Memory is flat by construction.** Latency goes into 80 fixed logarithmic buckets
per endpoint — 80 integers whether that endpoint has served ten requests or ten
billion — and percentiles are read back off the buckets. Metrics are keyed by route
template (`GET /api/market/instruments/:symbol`), never by URL, so a path parameter
cannot add a map entry per symbol. The instrument universe is replaced wholesale on
each listing rather than merged into. The per-request deadline and shutdown hook are
torn down explicitly instead of being left to `AbortSignal.timeout`/`AbortSignal.any`,
both of which leave an armed timer or a listener on a process-lifetime signal behind
for every request that completes normally.

**SIGTERM and SIGINT drain.** In-flight requests are aborted, sleeping users wake
immediately rather than sitting out a 30-second backoff, a final summary prints, and
the process exits 0. A second signal exits at once.

## Reading the output

```
[load-generator] 2026-08-04T00:26:12.956Z  up 1m0s  heap 11.2MB
  last 1m0s: 21.57 req/s  1295 req  ok 100.0%  rejected 0  failed 0 (0.0%)
  latency:      p50 7ms  p95 116ms  p99 133ms  max 121ms  mean 18ms
  day shape:    the open — rate 3.41x
  sessions:     16/16 signed in  0 backing off  16 logins this window (0 re-auth)
  statuses:     200:1289 201:6
  failures:     none
  trades:       6 filled  0 rejected  (6 filled since start)
  endpoint                                        req   req/s  fail     p50     p95
  GET /api/market/instruments                     276    4.60     0    38ms   133ms
  ...
  since start:  1295 req  21.57 req/s  ok 100.0%  failed 0  p95 116ms
```

Plain aligned text, no colour and no cursor control: this is read through `docker
logs` and log pipelines at least as often as in a terminal. Each block is
self-contained and timestamped, so one scraped out of a week of output still says
what it means. Percentiles are accurate to the bucket width (~15%) — enough to see a
regression, not enough to tune against.

`sessions: … backing off` is the number of users currently waiting out a failure; if
that sits at the roster size, the API is down and the generator is behaving.

`day shape` is there so the rate above it reads correctly. "0.4 req/s" looks like a
problem on its own and looks expected next to "overnight — rate 0.22x"; a `** burst **`
marker means the current minute is one of the day's spikes rather than something the API
did.

## Layout

| | |
|---|---|
| `src/main.js` | roster, signals, the process-level guarantees |
| `src/config.js` | every knob and its default |
| `src/user.js` | one virtual user: session, loop, backoff |
| `src/activities.js` | the weighted behaviour mix |
| `src/daypart.js` | the ET session curve, its noise, its bursts, and the activity tilt |
| `src/api.js` | one function per endpoint, with its metrics label |
| `src/client.js` | fetch, timeouts, concurrency gate, failure classification |
| `src/metrics.js` | constant-memory counters and histograms |
| `src/reporter.js` | the periodic summary and the heartbeat |
| `src/backoff.js` | jittered retry delays, and the abortable sleep |
| `src/random.js` | seeded PRNG and weighted choice |

## Notes and limits

- **It creates real accounts and moves real rows.** Every username in the roster is
  an account in the API's database, with a generated portfolio, and every filled
  order writes a lot and moves cash. Point it at a demo, not at anything you mind
  changing.
- **Lots accumulate.** Each buy inserts a row; sells consume them FIFO, so a long run
  trends upward in `lots` and the portfolio queries slowly get heavier. That is
  arguably realistic load, but it is growth in the *database*, not in this process,
  and `make db-reset` is the cure.
- **There is no assertion, only measurement.** It reports what happened; it does not
  fail a build. Latency numbers are client-side and include this process's own
  scheduling, which at high concurrency on a laptop is not nothing.

## Market intelligence uploads

One activity in the mix builds a synthetic intelligence file and posts it to
[`market-intel`](../market-intel/). It is in the same weighted table as browsing and
trading, so intel traffic is a share of one roster's attention rather than a second load
pattern layered on top — the point is a plausible mix, and an independent loop would make
the two services' load profiles uncorrelated in a way real users are not.

```bash
LOADGEN_INTEL_BASE_URL=http://localhost:8000 LOADGEN_INTEL_WEIGHT=10 npm start
```

**Empty base URL means no submissions at all**, which is the right behaviour when the intel
stack is not running — the alternative is a generator that spends its run producing
connection failures. On the deployed box the URL is derived from the same SSM parameter
that decides whether the stack is deployed, so the two cannot disagree.

### The files

Five formats, all built from the user's seeded PRNG, all with invented issuer names and
figures labelled synthetic:

| | |
|---|---|
| `text` (34%) | a wire story, padded to size |
| `json` (24%) | an envelope of items, `"synthetic": true` |
| `csv` (14%) | one row per item |
| `pdf` (18%) | **a real single-page PDF** — header, five objects, xref table, trailer. `file` identifies it and a reader opens it |
| `png` (10%) | **a real PNG** — noise pixels, correct chunk CRCs, padding in an ancillary chunk rather than after IEND |

The PDF and PNG are genuine rather than bytes with the right extension, because a
processor that one day actually parses them should be given something parseable. Both are
hand-assembled: `deflateSync` and a CRC-32 table are the whole toolchain.

Sizes follow a **skewed** distribution — mostly small with a long tail up to
`LOADGEN_INTEL_MAX_BYTES` — because the processor's cost is a function of size, and a
uniform pick across three orders of magnitude would put almost every request at the
ceiling. Measured over 200 files at the defaults: 564 B to 936 KB, most under 10 KB.

Half of the submissions are then polled to a result, the way a UI with a progress spinner
would be: a bounded number of attempts, then give up and move on. Some legitimately end
while the job is still running — a 2 MB file outlasts a user's patience, and that shows in
the report as `still running when we stopped watching` rather than as a failure.

### What the report adds

```
  intel:        12 queued  0 refused  mean 8 KiB  (20 queued since start)
  intel result: 7 processed  0 failed  0 still running when we stopped watching
  intel formats: text 5  pdf 4  csv 2  json 1
```

Absent entirely when nothing was submitted, so a run without the intel stack does not grow
two empty rows in every report. `mean KiB` is the number that explains the processor's
latency — with size-dependent processing, a rising p95 with a rising mean upload size is
the pipeline working, and a rising p95 with a flat one is not.

A 413 is counted as `refused`, not as an error: it means this generator built a file larger
than the service accepts, which is the limit working.
