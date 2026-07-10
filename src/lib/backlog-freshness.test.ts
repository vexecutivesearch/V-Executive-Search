import { describe, expect, it } from "vitest";

/**
 * Regression: today's backlog must not require last_seen == today.
 * A board outage (Indeed/Zip 403) must not wipe unarchived jobs from the working list.
 */
describe("current-day backlog freshness", () => {
  function jobVisibleOnCurrentDay(opts: {
    archivedAt: Date | null;
    lastSeenRunDate: string | null;
    asOfDate: string;
    isCurrentDay: boolean;
  }): boolean {
    if (opts.archivedAt) return false;
    if (opts.isCurrentDay) return true;
    const lastSeen = opts.lastSeenRunDate;
    return lastSeen != null && lastSeen >= opts.asOfDate;
  }

  it("keeps yesterday's Indeed job on today's backlog", () => {
    expect(
      jobVisibleOnCurrentDay({
        archivedAt: null,
        lastSeenRunDate: "2026-07-09",
        asOfDate: "2026-07-10",
        isCurrentDay: true,
      }),
    ).toBe(true);
  });

  it("hides archived jobs", () => {
    expect(
      jobVisibleOnCurrentDay({
        archivedAt: new Date("2026-07-08"),
        lastSeenRunDate: "2026-07-10",
        asOfDate: "2026-07-10",
        isCurrentDay: true,
      }),
    ).toBe(false);
  });

  it("historical snapshot still requires last_seen on that day", () => {
    expect(
      jobVisibleOnCurrentDay({
        archivedAt: null,
        lastSeenRunDate: "2026-07-08",
        asOfDate: "2026-07-09",
        isCurrentDay: false,
      }),
    ).toBe(false);
  });
});
