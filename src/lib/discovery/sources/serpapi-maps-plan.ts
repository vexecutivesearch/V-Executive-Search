/**
 * Which SerpApi Google Maps searches to make next. PURE — no network, no DB.
 *
 * Maps is a shallow pool with a hard floor and a hard ceiling: exactly 20
 * results per search, and SerpApi recommends a maximum `start` offset of 100
 * (page six) because past that "the result might be duplicated or irrelevant".
 * So one query in one market yields at most ~120 companies, ever. Sustaining
 * "25 new per day" therefore means walking a list of query seeds, not paging one
 * query deeper and deeper.
 *
 * The cursor stores SEARCH SLOTS consumed, not rows returned. Rows would drift:
 * a page that came back short would leave `start` misaligned with the offset
 * grid and silently re-bill for overlapping results. Slots are integers on a
 * fixed grid, so (seed, start) is always reconstructable and day 2 provably
 * starts where day 1 stopped.
 *
 *   slot:  0  1  2  3  4  5 | 6  7  8  9 10 11 | 12 …
 *   seed:  ——————— 0 ——————— | ——————— 1 ——————— | seed 2
 *   start: 0 20 40 60 80 100| 0 20 40 60 80 100| 0 …
 */

export const MAPS_PAGE_SIZE = 20;

/** start = 0, 20, 40, 60, 80, 100 — SerpApi's recommended ceiling. */
export const MAPS_PAGES_PER_SEED = 6;

export type MapsSweepStep = {
  /** Index into the vertical's query-seed list. */
  seedIndex: number;
  /** SerpApi `start` offset for this search. */
  start: number;
};

/**
 * Theoretical pool size for a (vertical, market): every seed paged to SerpApi's
 * recommended depth. Reported as the pool size so "exhausted — rotate market"
 * arrives with a denominator instead of out of nowhere.
 */
export function mapsPoolSize(seedCount: number): number {
  return mapsSlotCapacity(seedCount) * MAPS_PAGE_SIZE;
}

/** Total searches this (vertical, market) can ever justify. */
export function mapsSlotCapacity(seedCount: number): number {
  return Math.max(0, Math.trunc(seedCount)) * MAPS_PAGES_PER_SEED;
}

/** The (seed, start) pair a given slot index refers to. */
export function stepForSlot(slot: number): MapsSweepStep {
  const index = Math.max(0, Math.trunc(slot));
  return {
    seedIndex: Math.floor(index / MAPS_PAGES_PER_SEED),
    start: (index % MAPS_PAGES_PER_SEED) * MAPS_PAGE_SIZE,
  };
}

/**
 * Where to jump when a seed returns an empty page: the start of the next seed.
 *
 * Google has run out of results for THIS query, so the deeper offsets of the
 * same query are guaranteed-empty pages we would still be billed for. The other
 * seeds are untouched, so the pool as a whole is not exhausted — skipping the
 * dead seed's remaining pages is the difference between "roofing is done in
 * this county" and "stop looking at construction here".
 */
export function slotAfterEmptySeed(slot: number): number {
  const { seedIndex } = stepForSlot(slot);
  return (seedIndex + 1) * MAPS_PAGES_PER_SEED;
}
