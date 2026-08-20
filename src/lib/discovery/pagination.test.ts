import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  EMPTY_CURSOR,
  pageForCursor,
  poolStatus,
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
