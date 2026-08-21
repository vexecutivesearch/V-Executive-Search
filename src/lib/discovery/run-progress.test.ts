import { describe, expect, it } from "vitest";
import type { PoolStatus } from "./pagination";
import {
  findMoreLabel,
  marketProgress,
  nextRunHint,
} from "./run-progress";

function pool(overrides: Partial<PoolStatus> = {}): PoolStatus {
  return {
    poolSize: 21,
    consumed: 21,
    remaining: 0,
    exhausted: true,
    note: "Pool exhausted — rotate to another market or vertical.",
    ...overrides,
  };
}

describe("marketProgress", () => {
  it("does not call a market exhausted when only the sized pool is empty", () => {
    // The Finance / Palm Beach run: 21 sized companies done, 233 still
    // unpaged in the unfiltered pass. The old summary used sized.exhausted
    // as poolExhausted and told the operator to rotate.
    const progress = marketProgress({
      sized: pool({ poolSize: 21, consumed: 21, remaining: 0, exhausted: true }),
      unknown: pool({
        poolSize: 333,
        consumed: 100,
        remaining: 233,
        exhausted: false,
        note: null,
      }),
    });
    expect(progress.canFindMore).toBe(true);
    expect(progress.marketExhausted).toBe(false);
    expect(progress.nextAction).toBe("find_more");
    expect(progress.remainingAcrossPools).toBe(233);
    expect(findMoreLabel(25, progress)).toBe("Find 25 more");
    expect(nextRunHint(progress, 25)).toMatch(/233/);
  });

  it("is exhausted only when every pool we would search is empty", () => {
    const progress = marketProgress({
      sized: pool(),
      unknown: pool({
        poolSize: 333,
        consumed: 333,
        remaining: 0,
        exhausted: true,
      }),
    });
    expect(progress.canFindMore).toBe(false);
    expect(progress.marketExhausted).toBe(true);
    expect(progress.nextAction).toBe("rotate_or_reset");
  });

  it("treats a never-opened unknown pool as still searchable", () => {
    const progress = marketProgress({
      sized: pool(),
      unknown: null,
      includeUnknown: true,
    });
    expect(progress.canFindMore).toBe(true);
    expect(progress.nextAction).toBe("find_more");
  });

  it("ignores the unknown pool when the operator turned it off", () => {
    const progress = marketProgress({
      sized: pool(),
      unknown: pool({
        poolSize: 333,
        consumed: 0,
        remaining: 333,
        exhausted: false,
        note: null,
      }),
      includeUnknown: false,
    });
    expect(progress.canFindMore).toBe(false);
    expect(progress.marketExhausted).toBe(true);
  });

  it("is a first run when neither pool has been opened", () => {
    const progress = marketProgress({});
    expect(progress.firstRun).toBe(true);
    expect(progress.nextAction).toBe("first_run");
    expect(findMoreLabel(25, progress)).toBe("Find 25 companies");
  });
});
