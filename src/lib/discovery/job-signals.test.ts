import { describe, expect, it } from "vitest";
import { summarizeJobSignals } from "@/lib/discovery/job-signals";

const NOW = new Date("2026-03-01T12:00:00Z");

describe("summarizeJobSignals", () => {
  it("summarises open postings and the longest-running role", () => {
    const summary = summarizeJobSignals(
      [
        { title: "Controller", postedAt: new Date("2026-01-28T12:00:00Z") },
        { title: "Staff Accountant", postedAt: new Date("2026-02-20T12:00:00Z") },
        { title: "Bookkeeper", postedAt: new Date("2026-02-25T12:00:00Z") },
        { title: "Office Manager", firstSeenAt: new Date("2026-02-26T12:00:00Z") },
      ],
      NOW,
    );

    expect(summary.openPositions).toBe(4);
    expect(summary.label).toBe("4 active jobs, Controller open 32 days");
  });

  it("returns no signal for a company with no postings", () => {
    expect(summarizeJobSignals([], NOW)).toEqual({
      openPositions: 0,
      oldestTitle: null,
      oldestOpenDays: null,
      label: null,
      hasJobData: false,
    });
  });

  it("separates 'no job data' from 'zero open jobs'", () => {
    // Never scraped: we know nothing, so reports must not print a 0.
    expect(summarizeJobSignals([], NOW).hasJobData).toBe(false);

    // Scraped, everything since closed: 0 is a real, reportable count.
    const allClosed = summarizeJobSignals(
      [
        {
          title: "Paralegal",
          postedAt: new Date("2026-01-01T12:00:00Z"),
          archivedAt: new Date("2026-02-01T12:00:00Z"),
        },
      ],
      NOW,
    );
    expect(allClosed.hasJobData).toBe(true);
    expect(allClosed.openPositions).toBe(0);
  });

  it("ignores archived listings", () => {
    const summary = summarizeJobSignals(
      [
        {
          title: "Paralegal",
          postedAt: new Date("2026-01-01T12:00:00Z"),
          archivedAt: new Date("2026-02-01T12:00:00Z"),
        },
        { title: "Legal Assistant", postedAt: new Date("2026-02-27T12:00:00Z") },
      ],
      NOW,
    );
    expect(summary.openPositions).toBe(1);
    expect(summary.oldestTitle).toBe("Legal Assistant");
  });

  it("still counts a posting with no dates", () => {
    const summary = summarizeJobSignals([{ title: "Estimator" }], NOW);
    expect(summary.openPositions).toBe(1);
    expect(summary.oldestOpenDays).toBeNull();
    expect(summary.label).toBe("1 active job");
  });
});
