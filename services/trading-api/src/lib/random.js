/**
 * Deterministic randomness. Everything the demo "makes up" — prices, portfolios,
 * transaction history — is derived from a seed so that a given username always
 * sees the same account, and a restart with the same MARKET_SEED replays the
 * same market. No global Math.random anywhere in the data layer.
 */

/** FNV-1a. Stable across processes, unlike anything hash-order dependent. */
function hashString(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 — small, fast, good enough for synthetic market data. */
function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller. Returns a standard normal sample from a uniform generator. */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const randomInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

const randomBetween = (rng, min, max) => min + rng() * (max - min);

const pick = (rng, items) => items[Math.floor(rng() * items.length)];

/** Choose `count` distinct items without mutating the source array. */
function sample(rng, items, count) {
  const pool = [...items];
  const chosen = [];
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i += 1) {
    chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return chosen;
}

module.exports = { hashString, createRng, gaussian, sample, randomInt, randomBetween, pick };
