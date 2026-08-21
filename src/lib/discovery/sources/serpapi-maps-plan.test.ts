import { describe, expect, it } from "vitest";
import {
  MAPS_PAGES_PER_SEED,
  MAPS_PAGE_SIZE,
  mapsPoolSize,
  mapsSlotCapacity,
  slotAfterEmptySeed,
  stepForSlot,
} from "@/lib/discovery/sources/serpapi-maps-plan";

/*
 * These constants are SerpApi's, not ours: google_maps returns exactly 20
 * results per search and SerpApi documents a recommended maximum `start` of
 * 100 (page six) because past that "the result might be duplicated or
 * irrelevant". Changing them changes what the operator is billed for.
 */
describe("Maps grid constants match SerpApi's documented behaviour", () => {
  it("is 20 results per search, six pages deep", () => {
    expect(MAPS_PAGE_SIZE).toBe(20);
    expect(MAPS_PAGES_PER_SEED).toBe(6);
  });

  it("tops out at start=100 on the last page of a seed", () => {
    expect(stepForSlot(MAPS_PAGES_PER_SEED - 1).start).toBe(100);
  });
});

describe("stepForSlot", () => {
  it("walks a seed's pages before moving to the next seed", () => {
    expect(stepForSlot(0)).toEqual({ seedIndex: 0, start: 0 });
    expect(stepForSlot(1)).toEqual({ seedIndex: 0, start: 20 });
    expect(stepForSlot(5)).toEqual({ seedIndex: 0, start: 100 });
    expect(stepForSlot(6)).toEqual({ seedIndex: 1, start: 0 });
    expect(stepForSlot(13)).toEqual({ seedIndex: 2, start: 20 });
  });

  it("clamps nonsense input to the first slot", () => {
    expect(stepForSlot(-4)).toEqual({ seedIndex: 0, start: 0 });
    expect(stepForSlot(2.7)).toEqual({ seedIndex: 0, start: 40 });
  });

  /*
   * The whole reason the cursor counts search slots rather than rows returned:
   * slots stay on the offset grid, so a short page cannot leave `start`
   * misaligned and silently re-bill for overlapping results.
   */
  it("is a pure function of the slot index, so day 2 resumes exactly", () => {
    const slots = [0, 3, 6, 11, 12];
    expect(slots.map(stepForSlot)).toEqual(slots.map(stepForSlot));
  });
});

describe("capacity and pool size", () => {
  it("gives every seed six searches", () => {
    expect(mapsSlotCapacity(4)).toBe(24);
    expect(mapsSlotCapacity(0)).toBe(0);
    expect(mapsSlotCapacity(-2)).toBe(0);
  });

  it("reports the pool in companies, not searches", () => {
    // Construction has 8 keyword tags → 8 × 6 × 20 = 960 theoretical companies.
    expect(mapsPoolSize(8)).toBe(960);
    // Legal has 4 → 480.
    expect(mapsPoolSize(4)).toBe(480);
  });
});

/*
 * A dry seed means Google has no more results for THAT query. Its deeper
 * offsets are guaranteed-empty pages we would still be billed for, so they are
 * skipped — but the other seeds are untouched, so the pool is not exhausted.
 */
describe("slotAfterEmptySeed", () => {
  it("jumps to the first page of the next seed", () => {
    expect(slotAfterEmptySeed(0)).toBe(6);
    expect(slotAfterEmptySeed(2)).toBe(6);
    expect(slotAfterEmptySeed(5)).toBe(6);
    expect(slotAfterEmptySeed(6)).toBe(12);
    expect(slotAfterEmptySeed(11)).toBe(12);
  });

  it("always moves forward, so a sweep cannot loop", () => {
    for (let slot = 0; slot < 30; slot += 1) {
      expect(slotAfterEmptySeed(slot)).toBeGreaterThan(slot);
    }
  });
});
