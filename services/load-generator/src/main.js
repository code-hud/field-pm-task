/**
 * Entry point: build the roster, start it, report on it, and stop it cleanly.
 *
 * The contract this file exists to keep is that the process does not die. Virtual
 * users already survive anything the API does to them (see user.js); what is left is
 * everything outside their loops — a rejected promise nobody awaited, a throw from a
 * timer callback, a signal. Node's default for the first two is to exit, which for a
 * service meant to run for weeks is the wrong default, so both are handled here.
 */
import { setMaxListeners } from 'node:events';

import { abortInFlight } from './client.js';
import { config, describeConfig } from './config.js';
import { describeDayShape } from './daypart.js';
import { marketStatus } from './api.js';
import { metrics } from './metrics.js';
import { report, startReporting } from './reporter.js';
import { VirtualUser } from './user.js';

const log = (message) => console.log(`[${config.serviceName}] ${message}`);

/** Fires on shutdown so users parked on a think-time or a backoff wake immediately. */
const stopping = new AbortController();
// One waiter per sleeping user, which is more than the default warning threshold as
// soon as the roster passes ten.
setMaxListeners(0, stopping.signal);

let stopReporting = () => {};
let stopped = false;

function shutdown(reason, { exitCode = 0 } = {}) {
  if (stopped) {
    // A second signal means someone is impatient, or the graceful path is stuck.
    log('second signal — exiting immediately.');
    process.exit(exitCode);
  }
  stopped = true;

  log(`${reason} — draining.`);
  stopping.abort();
  abortInFlight();
  stopReporting();

  // Backstop: if a user somehow does not return, the container should still stop
  // within its grace period rather than be killed with SIGKILL.
  const forced = setTimeout(() => {
    log('drain timed out — exiting hard.');
    process.exit(exitCode);
  }, 8000);
  forced.unref();
}

/**
 * One probe before the roster starts, so a mistyped LOADGEN_BASE_URL is obvious in
 * the first line of the log rather than inferred from a wall of network errors. It
 * does not gate startup: the users' own backoff is the answer to an API that is not
 * up yet, and gating here would just be a second, worse copy of it.
 */
async function preflight() {
  const result = await marketStatus();
  if (result.ok) {
    log(`API reachable — market is ${result.body?.label ?? result.body?.phase ?? 'up'}.`);
  } else {
    log(
      `API not reachable yet (${result.kind}${result.detail ? `: ${result.detail}` : ''}) — ` +
        'starting anyway; users will back off until it answers.',
    );
  }
}

async function main() {
  log('starting');
  // Logged next to the rest of the configuration rather than from describeConfig, so
  // config.js stays free of an import cycle back through daypart.js.
  console.log(`  ${describeConfig()}\n  day shape       ${describeDayShape()}\n`);

  await preflight();

  const usernames = config.users.usernames;
  // Spread the first sign-ins over the ramp window. Each one that lands on a new
  // username makes the API generate a whole portfolio, which is by far the most
  // expensive thing it does — all of them at once is a self-inflicted stampede.
  const spacing = usernames.length > 1 ? config.users.rampMs / (usernames.length - 1) : 0;

  const users = usernames.map(
    (username, index) =>
      new VirtualUser(username, {
        startDelayMs: Math.round(index * spacing),
        signal: stopping.signal,
      }),
  );

  stopReporting = startReporting();

  if (config.durationSec > 0) {
    const timer = setTimeout(() => shutdown(`ran for ${config.durationSec}s`), config.durationSec * 1000);
    timer.unref();
  }

  // allSettled, not all: one user rejecting must not cancel the other nineteen.
  const outcomes = await Promise.allSettled(users.map((user) => user.run()));
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      console.error(`[${config.serviceName}] a user loop exited unexpectedly:`, outcome.reason);
    }
  }

  log('final summary:');
  report();
  log(
    `stopped after ${metrics.total.sent} requests, ${metrics.total.failed} failed, ` +
      `${metrics.total.trades.filled} trades filled.`,
  );
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Neither of these may end the run. An unhandled rejection is a bug in this
// generator and is printed as one, but a load generator that quits on its own bug
// three weeks into a soak is worse than one that logs it and keeps going.
process.on('unhandledRejection', (reason) => {
  console.error(`[${config.serviceName}] unhandled rejection (ignored, run continues):`, reason);
});

process.on('uncaughtException', (error) => {
  console.error(`[${config.serviceName}] uncaught exception (ignored, run continues):`, error);
});

await main();

// Be explicit rather than relying on the loop draining: an unref'd report timer or a
// socket the agent has not closed yet should not turn a finished run into a hang.
process.exit(0);
