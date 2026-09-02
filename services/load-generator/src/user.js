/**
 * One virtual user: a session, a seeded stream of decisions, and a loop that is not
 * allowed to stop.
 *
 * The loop is the fault tolerance. Everything inside it — the sign-in, the activity,
 * the pause — is wrapped, and every exit from that wrapper leads back to the top of
 * the loop after a backoff. A user whose API is unreachable is indistinguishable
 * from one whose API is slow: both wait, both come back, neither ends the process.
 */
import { Backoff, running, sleep } from './backoff.js';
import { chooseActivity, knownSymbols } from './activities.js';
import { daypart, shapePause } from './daypart.js';
import * as api from './api.js';
import { config, seedFor } from './config.js';
import { createRng, pick, randomBetween } from './random.js';
import { metrics } from './metrics.js';

/**
 * Unwinds the current journey without unwinding the user. Thrown by `step` when a
 * request fails in a way that makes the rest of the journey pointless — there is no
 * chart to open if the instrument list never arrived.
 */
class ActivityAborted extends Error {
  constructor(result) {
    super(result.detail ?? result.kind);
    this.name = 'ActivityAborted';
    this.result = result;
  }
}

// Failures are logged at most once per kind per LOADGEN_ERROR_LOG_INTERVAL_MS. A
// dead API otherwise produces a line per user per retry and buries the summary.
const lastLoggedAt = new Map();

function logThrottled(kind, message) {
  if (config.errorLogIntervalMs === 0) return;
  const now = Date.now();
  if (now - (lastLoggedAt.get(kind) ?? 0) < config.errorLogIntervalMs) return;
  lastLoggedAt.set(kind, now);
  console.warn(`[${config.serviceName}] ${message}`);
}

/** Reads `exp` out of a JWT without verifying it — this is a client, not a gate. */
function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class VirtualUser {
  constructor(username, { startDelayMs = 0, signal } = {}) {
    this.username = username;
    this.rng = createRng(seedFor(username));
    this.backoff = new Backoff(this.rng);
    this.startDelayMs = startDelayMs;
    this.signal = signal;
    this.token = null;
    this.tokenExpiresAt = null;
    this.hasSignedIn = false;
    // The last portfolio seen, kept only so a trade can size itself without an extra
    // read. One object, overwritten — deliberately not a history.
    this.lastPortfolio = null;
    // The daypart this iteration is acting in, refreshed at the top of every loop.
    this.day = null;
  }

  /**
   * Awaits one API call and decides whether the journey can continue.
   *
   * `tolerate` lets a caller opt into handling a status itself — trading uses it for
   * the 404 that means "this API has no order entry".
   */
  async step(pending, { tolerate = [] } = {}) {
    const result = await pending;

    if (result.kind === 'aborted') throw new ActivityAborted(result);
    if (tolerate.includes(result.status)) return result;

    if (result.kind === 'unauthorized') {
      // The session is gone — expired, or the API restarted with a different secret.
      this.#clearSession();
      throw new ActivityAborted(result);
    }

    if (!result.ok && result.kind !== 'rejected') throw new ActivityAborted(result);
    return result;
  }

  /**
   * Think time, in the range configured, scaled by the time of day, cut short by a
   * shutdown.
   *
   * The scaling is where the diurnal shape actually happens: the roster is a fixed size,
   * so the only lever on arrival rate is how long each user waits between acting. At the
   * open they wait a third as long as configured; at 03:00, eight times as long.
   *
   * `shaped: false` opts out, for waits that are not think time. The intel poll loop is
   * the one caller that needs it — its interval is a property of the UI it imitates, and
   * polling a job's status faster because the market is busy would be a claim about the
   * client that this generator is not making.
   */
  pause(minMs = config.thinkMinMs, maxMs = config.thinkMaxMs, { shaped = true } = {}) {
    const drawn = Math.round(randomBetween(this.rng, minMs, Math.max(maxMs, minMs)));
    const ms = shaped ? shapePause(drawn, (this.day ?? daypart()).factor) : drawn;
    return sleep(ms, this.signal);
  }

  rememberPortfolio(body) {
    if (body?.summary) this.lastPortfolio = body;
  }

  /** A symbol to act on, listing the universe first if this user has not seen one. */
  async symbol() {
    const symbols = knownSymbols();
    if (symbols.length > 0) return pick(this.rng, symbols);

    const listing = await this.step(api.instruments(this.token, { limit: 25 }));
    const returned = listing.body?.instruments ?? [];
    return returned.length > 0 ? pick(this.rng, returned).symbol : null;
  }

  #clearSession() {
    if (this.token) metrics.activeSessions -= 1;
    this.token = null;
    this.tokenExpiresAt = null;
  }

  /**
   * Signs in if there is no live session. Refreshes a minute before the token's own
   * expiry rather than waiting for the 401: with every user's token minted in the
   * same ramp window, they would all expire together and the API would take the
   * whole roster's re-login as one burst.
   */
  async #ensureSession() {
    const expiringSoon = this.tokenExpiresAt !== null && Date.now() > this.tokenExpiresAt - 60_000;
    if (this.token && !expiringSoon) return;
    if (expiringSoon) this.#clearSession();

    const result = await this.step(api.login(this.username, config.users.password));
    const token = result.body?.token;
    if (!token) throw new ActivityAborted({ kind: 'client_error', detail: 'login returned no token' });

    this.token = token;
    this.tokenExpiresAt = tokenExpiry(token);
    metrics.activeSessions += 1;
    metrics.countLogin({ reauth: this.hasSignedIn });
    this.hasSignedIn = true;
  }

  async run() {
    // Stagger the start so the roster's first logins — each of which generates a
    // portfolio — do not all land on the API in the same millisecond.
    if (!(await sleep(this.startDelayMs, this.signal))) return;

    while (running()) {
      try {
        await this.#ensureSession();

        // One daypart read per iteration, shared by the activity mix and by every
        // pause inside the journey it picks, so a user's choice and the waits that
        // follow it describe the same minute even when the loop straddles a boundary.
        this.day = daypart();
        const activity = chooseActivity(this.rng, this.day);
        if (activity) await activity.run(this);

        this.backoff.succeed();
        if (!(await this.pause())) return;
      } catch (error) {
        if (!running()) return;
        const waitMs = this.backoff.fail();

        if (error instanceof ActivityAborted) {
          logThrottled(
            error.result.kind,
            `${error.result.kind}: ${error.message} — ${this.username} and others backing off ` +
              `(attempt ${this.backoff.failures}, next in ~${waitMs}ms)`,
          );
        } else {
          // A bug in this generator, not a failure of the API. It must still not end
          // the run, so it is logged loudly and treated like any other failure.
          logThrottled('internal', `internal error in ${this.username}'s loop: ${error?.stack ?? error}`);
        }

        metrics.backingOff += 1;
        const completed = await sleep(waitMs, this.signal);
        metrics.backingOff -= 1;
        if (!completed) return;
      }
    }
  }
}
