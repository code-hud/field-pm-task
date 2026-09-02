/**
 * Seeded randomness, so a load run is reproducible.
 *
 * The same LOADGEN_SEED replays the same roster, the same activity choices, and the
 * same think times — which is what turns "it fell over after an hour" into something
 * you can run again. Nothing here calls Math.random.
 *
 * This is the same FNV-1a + mulberry32 pair as the trading API's src/lib/random.js,
 * copied rather than shared: each service builds from its own directory with no
 * shared build context, and forty lines of arithmetic is a cheaper duplicate than a
 * workspace package that couples two independently shippable images.
 */

/** FNV-1a. Stable across processes, so a username always maps to the same stream. */
export function hashString(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 — small, fast, and good enough to pick between activities. */
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

export const randomBetween = (rng, min, max) => min + rng() * (max - min);

export const pick = (rng, items) => items[Math.floor(rng() * items.length)];

/**
 * Weighted choice over `[{ weight, ... }]`. Entries with weight <= 0 are unreachable,
 * which is how trading is turned off without a second code path.
 */
export function pickWeighted(rng, entries) {
  const total = entries.reduce((sum, entry) => sum + Math.max(entry.weight, 0), 0);
  if (total <= 0) return null;

  let cursor = rng() * total;
  for (const entry of entries) {
    cursor -= Math.max(entry.weight, 0);
    if (cursor <= 0) return entry;
  }
  return entries.at(-1);
}
