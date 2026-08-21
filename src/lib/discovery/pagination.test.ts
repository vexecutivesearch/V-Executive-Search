import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  EMPTY_CURSOR,
  pageForCursor,
  poolStatus,
  reconcileCursor,
} from "@/lib/discovery/pagination";

describe("discovery pagination cursor", () => {
  it("starts on page 1 and advances a page per run", () => {
    const day1 = { ...EMPTY_CURSOR };
    expect(pageForCursor(day1, 25)).toBe(1);

    const day2 = advanceCursor(day1, {
      requested: 25,
      returned: 25,
      totalEntries: 310,
      perPage: 25,
    });
    expect(day2.consumed).toBe(25);
    expect(pageForCursor(day2, 25)).toBe(2);

    const day3 = advanceCursor(day2, {
      requested: 25,
      returned: 25,
      totalEntries: 310,
      perPage: 25,
    });
    expect(pageForCursor(day3, 25)).toBe(3);
    expect(day3.poolExhausted).toBe(false);
  });

  it("reports pool size, consumed and remaining", () => {
    const cursor = advanceCursor(EMPTY_CURSOR, {
      requested: 25,
      returned: 25,
      totalEntries: 310,
      perPage: 25,
    });
    expect(poolStatus(cursor)).toEqual({
      poolSize: 310,
      consumed: 25,
      remaining: 285,
      exhausted: false,
      note: null,
    });
  });

  it("flags exhaustion on a short page and asks for a market rotation", () => {
    const cursor = advanceCursor(
      { perPage: 25, consumed: 275, totalEntries: 310, poolExhausted: false },
      { requested: 25, returned: 9, totalEntries: 310, perPage: 25 },
    );
    const status = poolStatus(cursor);
    expect(cursor.poolExhausted).toBe(true);
    expect(status.exhausted).toBe(true);
    expect(status.note).toMatch(/rotate/i);
  });

  it("flags exhaustion once the whole pool has been consumed", () => {
    const cursor = advanceCursor(
      { perPage: 25, consumed: 285, totalEntries: 310, poolExhausted: false },
      { requested: 25, returned: 25, totalEntries: 310, perPage: 25 },
    );
    expect(cursor.consumed).toBe(310);
    expect(poolStatus(cursor).remaining).toBe(0);
    expect(cursor.poolExhausted).toBe(true);
  });

  it("stays exhausted once exhausted", () => {
    const cursor = advanceCursor(
      { perPage: 25, consumed: 310, totalEntries: 310, poolExhausted: true },
      { requested: 25, returned: 25, totalEntries: 400, perPage: 25 },
    );
    expect(cursor.poolExhausted).toBe(true);
  });

  it("derives the page from consumed so a changed run size cannot rewind", () => {
    const cursor = { perPage: 25, consumed: 75, totalEntries: 310, poolExhausted: false };
    expect(pageForCursor(cursor, 25)).toBe(4);
    // Operator switches to 50 per run: the offset moves forward, never back.
    expect(pageForCursor(cursor, 50)).toBe(2);
  });

  /*
   * Both Apollo passes now page at 100 while the operator still asks for 25 a
   * run, because a page costs one credit either way. These assert that the
   * cursor stays honest once page size and requested limit are decoupled.
   */
  describe("page size decoupled from the requested limit", () => {
    it("counts every row the credit paid for, not just the ones reviewed", () => {
      // 100 rows fetched, 25 handed to the operator. All 100 have been seen for
      // this (vertical, market), so re-buying them tomorrow would be waste.
      const after = advanceCursor(EMPTY_CURSOR, {
        requested: 100,
        returned: 100,
        totalEntries: 310,
        perPage: 100,
      });
      expect(after.consumed).toBe(100);
      expect(pageForCursor(after, 100)).toBe(2);
      expect(after.poolExhausted).toBe(false);
    });

    it("reaches honest exhaustion four times sooner", () => {
      let cursor = { ...EMPTY_CURSOR };
      let pages = 0;
      // A 310-company pool: four pages of 100 (the last one short), versus the
      // thirteen runs the old 25-row page needed to admit it was empty.
      while (!cursor.poolExhausted && pages < 20) {
        const returned = Math.min(100, 310 - cursor.consumed);
        cursor = advanceCursor(cursor, {
          requested: 100,
          returned,
          totalEntries: 310,
          perPage: 100,
        });
        pages += 1;
      }
      expect(pages).toBe(4);
      expect(cursor.consumed).toBe(310);
      expect(poolStatus(cursor).exhausted).toBe(true);
    });

    it("does not read a full page as a short one", () => {
      // The trap in the fix: comparing `returned` against the run's limit (25)
      // instead of the page size would see 100 > 25, or a 30-row page as short,
      // and declare a healthy pool exhausted on the first run.
      const full = advanceCursor(EMPTY_CURSOR, {
        requested: 100,
        returned: 100,
        totalEntries: null,
        perPage: 100,
      });
      expect(full.poolExhausted).toBe(false);

      const short = advanceCursor(EMPTY_CURSOR, {
        requested: 100,
        returned: 30,
        totalEntries: null,
        perPage: 100,
      });
      expect(short.poolExhausted).toBe(true);
    });

    it("moves forward, not back, on the run that switches page size", () => {
      // A cursor accumulated at 25 rows a page lands mid-page on the 100 grid,
      // so a few organizations repeat once. Dedupe absorbs them; what must not
      // happen is the offset rewinding and re-reviewing a whole page.
      const legacy = {
        perPage: 25,
        consumed: 75,
        totalEntries: 310,
        poolExhausted: false,
      };
      expect(pageForCursor(legacy, 100)).toBe(1);
      const next = advanceCursor(legacy, {
        requested: 100,
        returned: 100,
        totalEntries: 310,
        perPage: 100,
      });
      expect(next.consumed).toBe(175);
      expect(pageForCursor(next, 100)).toBe(2);
    });
  });

  describe("reconcileCursor", () => {
    it("resets an exhausted cursor written at the old 25-row page size", () => {
      const stale = {
        perPage: 25,
        consumed: 160,
        totalEntries: 160,
        poolExhausted: true,
      };
      const { cursor, resetReason } = reconcileCursor(stale, 100);
      expect(resetReason).toBe("page_size_changed");
      expect(cursor).toEqual({
        perPage: 100,
        consumed: 0,
        totalEntries: null,
        poolExhausted: false,
      });
    });

    it("resets a cursor that consumed past its own pool (19 claimed, 25 consumed)", () => {
      const { cursor, resetReason } = reconcileCursor(
        {
          perPage: 25,
          consumed: 25,
          totalEntries: 19,
          poolExhausted: true,
        },
        100,
      );
      expect(resetReason).toBe("consumed_past_pool");
      expect(cursor.poolExhausted).toBe(false);
      expect(cursor.consumed).toBe(0);
    });

    it("does not rewind an in-progress cursor when only the page size changed", () => {
      const mid = {
        perPage: 25,
        consumed: 75,
        totalEntries: 310,
        poolExhausted: false,
      };
      const { cursor, resetReason } = reconcileCursor(mid, 100);
      expect(resetReason).toBeNull();
      expect(cursor).toEqual(mid);
    });

    it("leaves a matching exhausted cursor alone so we do not re-buy an empty pool", () => {
      const done = {
        perPage: 100,
        consumed: 19,
        totalEntries: 19,
        poolExhausted: true,
      };
      const { cursor, resetReason } = reconcileCursor(done, 100);
      expect(resetReason).toBeNull();
      expect(cursor).toEqual(done);
    });
  });

  it("leaves pool size unknown before the first run", () => {
    expect(poolStatus(EMPTY_CURSOR)).toEqual({
      poolSize: null,
      consumed: 0,
      remaining: null,
      exhausted: false,
      note: null,
    });
  });
});
