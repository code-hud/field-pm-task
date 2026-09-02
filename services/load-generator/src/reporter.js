/**
 * The periodic summary, written for `docker logs`.
 *
 * Plain aligned text, no colour and no cursor control: this is read through a log
 * pipeline as often as through a terminal, and escape codes make it unreadable
 * there. Each block is self-contained and timestamped, so a block scraped out of a
 * week of logs still says what it means.
 */
import { writeFileSync } from 'node:fs';

import { config } from './config.js';
import { daypart } from './daypart.js';
import { metrics } from './metrics.js';

const pad = (value, width) => String(value).padStart(width);
const padEnd = (value, width) => String(value).padEnd(width);

const rate = (count, seconds) => (count / seconds).toFixed(2);

const percent = (part, whole) => (whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`);

const duration = (ms) => {
  const seconds = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(seconds / 86400), 'd'],
    [Math.floor(seconds / 3600) % 24, 'h'],
    [Math.floor(seconds / 60) % 60, 'm'],
    [seconds % 60, 's'],
  ].filter(([value], index, all) => value > 0 || index === all.length - 1);
  return parts.map(([value, unit]) => `${value}${unit}`).join('');
};

const heapMb = () => (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

/** `{code: n}` pairs, busiest first, so a burst of 500s is visible at a glance. */
const formatCounts = (map) => {
  const entries = [...map.entries()].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? 'none' : entries.map(([key, count]) => `${key}:${count}`).join(' ');
};

export function report() {
  const { window, total } = metrics;
  const windowSec = window.elapsedSec;
  const lines = [];

  lines.push(
    `[${config.serviceName}] ${new Date().toISOString()}  up ${duration(Date.now() - metrics.startedAt)}  ` +
      `heap ${heapMb()}MB`,
  );
  lines.push(
    `  last ${duration(windowSec * 1000)}: ${rate(window.sent, windowSec)} req/s  ` +
      `${window.sent} req  ok ${percent(window.ok, window.sent)}  ` +
      `rejected ${window.rejected}  failed ${window.failed} (${percent(window.failed, window.sent)})`,
  );
  lines.push(
    `  latency:      p50 ${window.latency.quantile(0.5)}ms  p95 ${window.latency.quantile(0.95)}ms  ` +
      `p99 ${window.latency.quantile(0.99)}ms  max ${Math.round(window.latency.max)}ms  ` +
      `mean ${window.latency.mean.toFixed(0)}ms`,
  );
  // The shape, in the same block as the rate it explains: "0.4 req/s" reads as a
  // problem on its own and as expected next to "overnight, 0.16x".
  const day = daypart();
  lines.push(
    `  day shape:    ${day.label} — rate ${day.factor.toFixed(2)}x` +
      `${day.bursting ? '  ** burst **' : ''}`,
  );
  lines.push(
    `  sessions:     ${metrics.activeSessions}/${config.users.usernames.length} signed in  ` +
      `${metrics.backingOff} backing off  ${window.logins} logins this window ` +
      `(${window.reauths} re-auth)`,
  );
  lines.push(`  statuses:     ${formatCounts(window.statuses)}`);
  lines.push(`  failures:     ${formatCounts(window.failureKinds)}`);
  lines.push(
    `  trades:       ${window.trades.filled} filled  ${window.trades.rejected} rejected  ` +
      `(${total.trades.filled} filled since start)`,
    ...intelLines(window, total),
  );

  const endpoints = [...window.endpoints.entries()].sort((a, b) => b[1].sent - a[1].sent);
  if (endpoints.length > 0) {
    lines.push(`  ${padEnd('endpoint', 44)}${pad('req', 7)}${pad('req/s', 8)}${pad('fail', 6)}${pad('p50', 8)}${pad('p95', 8)}`);
    for (const [label, stats] of endpoints) {
      if (stats.sent === 0) continue;
      lines.push(
        `  ${padEnd(label, 44)}${pad(stats.sent, 7)}${pad(rate(stats.sent, windowSec), 8)}` +
          `${pad(stats.failed, 6)}${pad(`${stats.latency.quantile(0.5)}ms`, 8)}` +
          `${pad(`${stats.latency.quantile(0.95)}ms`, 8)}`,
      );
    }
  }

  const totalSec = (Date.now() - metrics.startedAt) / 1000;
  lines.push(
    `  since start:  ${total.sent} req  ${rate(total.sent, totalSec)} req/s  ` +
      `ok ${percent(total.ok, total.sent)}  failed ${total.failed}  ` +
      `p95 ${total.latency.quantile(0.95)}ms`,
  );

  console.log(lines.join('\n'));
  if (window.sent > 0) heartbeat();
  metrics.rollWindow();
}

/**
 * Proof of life for the container healthcheck. Written only when the window saw
 * traffic, so a process that is still ticking its report timer but has stopped
 * issuing requests goes stale and is caught.
 */
function heartbeat() {
  if (!config.heartbeatFile) return;
  try {
    writeFileSync(config.heartbeatFile, `${Date.now()}\n`);
  } catch (error) {
    // A read-only filesystem is a deployment choice, not a reason to stop working.
    console.warn(`[${config.serviceName}] could not write heartbeat: ${error.message}`);
  }
}

export function startReporting() {
  // Write one heartbeat up front. Otherwise the file does not exist until the first
  // report, and a long LOADGEN_REPORT_INTERVAL_MS would leave the container unhealthy
  // past its start period for no reason.
  heartbeat();
  const timer = setInterval(report, config.reportIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The market-intel lines, and nothing at all when no intel was submitted — a stack
 * without the `intel` profile should not grow two empty rows in every report.
 */
function intelLines(window, total) {
  if (total.intel.accepted + total.intel.refused === 0) return [];

  const submitted = window.intel.accepted + window.intel.refused;
  const meanKiB = submitted > 0 ? Math.round(window.intel.bytes / submitted / 1024) : 0;
  const kinds = [...window.intelKinds.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`)
    .join('  ');

  return [
    `  intel:        ${window.intel.accepted} queued  ${window.intel.refused} refused  ` +
      `mean ${meanKiB} KiB  (${total.intel.accepted} queued since start)`,
    `  intel result: ${window.intel.done} processed  ${window.intel.failed} failed  ` +
      `${window.intel.pending} still running when we stopped watching` +
      (kinds ? `\n  intel formats: ${kinds}` : ''),
  ];
}
