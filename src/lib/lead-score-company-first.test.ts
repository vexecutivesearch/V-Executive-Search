import { describe, expect, it } from "vitest";
import type { pipelineSettings } from "@/lib/db/schema";
import { scoreCompanyFirst, scoreCompanyPreEnrich } from "@/lib/lead-score";

const geoSettings = {
  geographicScope: "city",
  focusState: "Florida",
  focusCity: "West Palm Beach",
  metroCities: ["West Palm Beach", "Boca Raton"],
} as unknown as typeof pipelineSettings.$inferSelect;

/** A typical job-scraped lead: two in-focus listings and repost signals. */
function jobScrapedScore(): number {
  return scoreCompanyPreEnrich({
    icpStatus: "pass",
    hiringSignals: { reposted_role: 3, multiple_openings: 2 },
    domainConfidence: "high",
    listings: [
      { location: "West Palm Beach, FL" },
      { location: "Boca Raton, FL" },
    ],
    geoSettings,
    hrOnlyDeprioritize: false,
  });
}

describe("scoreCompanyFirst", () => {
  it("keeps a no-jobs discovered company well clear of the bottom", () => {
    const score = scoreCompanyFirst({
      vertical: "legal",
      icpStatus: "pass",
      estimatedEmployees: 12,
      domainConfidence: "high",
      hasPhone: true,
      hasLinkedIn: true,
      hiringSignals: {},
      openPositions: 0,
    });

    // The old job-shaped path would have given this company ~28.
    expect(score).toBeGreaterThanOrEqual(60);
    const jobShaped = scoreCompanyPreEnrich({
      icpStatus: "pass",
      hiringSignals: {},
      domainConfidence: "high",
      listings: [],
      geoSettings,
      hrOnlyDeprioritize: false,
    });
    expect(score).toBeGreaterThan(jobShaped);
  });

  it("still ranks a bare discovered company above the floor", () => {
    const score = scoreCompanyFirst({
      vertical: "construction",
      icpStatus: "unknown",
      estimatedEmployees: null,
      domainConfidence: "low",
      hasPhone: false,
      hasLinkedIn: false,
      hiringSignals: {},
      openPositions: 0,
    });
    expect(score).toBeGreaterThanOrEqual(40);
  });

  it("treats job activity as a bonus, not the base", () => {
    const base = {
      vertical: "finance_accounting",
      icpStatus: "pass" as const,
      estimatedEmployees: 60,
      domainConfidence: "high",
      hasPhone: true,
      hasLinkedIn: true,
    };
    const withoutJobs = scoreCompanyFirst({
      ...base,
      hiringSignals: {},
      openPositions: 0,
    });
    const withJobs = scoreCompanyFirst({
      ...base,
      hiringSignals: { multiple_openings: 4 },
      openPositions: 4,
    });
    expect(withJobs).toBeGreaterThan(withoutJobs);
    expect(withJobs - withoutJobs).toBeLessThanOrEqual(30);
  });

  it("credits size-band fit and penalises out-of-band headcount", () => {
    const shared = {
      vertical: "legal",
      icpStatus: "pass" as const,
      domainConfidence: "high",
      hasPhone: false,
      hasLinkedIn: false,
      hiringSignals: {},
      openPositions: 0,
    };
    const inBand = scoreCompanyFirst({ ...shared, estimatedEmployees: 40 });
    const unknown = scoreCompanyFirst({ ...shared, estimatedEmployees: null });
    const outOfBand = scoreCompanyFirst({
      ...shared,
      estimatedEmployees: 4000,
    });
    expect(inBand).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(outOfBand);
  });

  it("sinks companies carrying deterministic exclusion flags", () => {
    const flagged = scoreCompanyFirst({
      vertical: "general_professional",
      icpStatus: "pass",
      estimatedEmployees: 400,
      domainConfidence: "high",
      hasPhone: true,
      hasLinkedIn: true,
      hiringSignals: {},
      openPositions: 2,
      exclusionFlags: ["fortune_500"],
    });
    const clean = scoreCompanyFirst({
      vertical: "general_professional",
      icpStatus: "pass",
      estimatedEmployees: 400,
      domainConfidence: "high",
      hasPhone: true,
      hasLinkedIn: true,
      hiringSignals: {},
      openPositions: 2,
    });
    expect(flagged).toBeLessThan(clean - 30);
  });

  it("zeroes an ICP-failed company", () => {
    expect(
      scoreCompanyFirst({
        vertical: "legal",
        icpStatus: "fail",
        estimatedEmployees: 5000,
        domainConfidence: "high",
        hasPhone: true,
        hasLinkedIn: true,
        hiringSignals: {},
        openPositions: 0,
      }),
    ).toBe(0);
  });
});

describe("job-scraped scoring is unchanged", () => {
  it("keeps the existing hiring-signal score for a scraped lead", () => {
    // Base 20 + in-focus 25 + 2 in-focus 10 + high domain 8 + reposted 28 +
    // multiple openings 18 = 109, clamped to 100.
    expect(jobScrapedScore()).toBe(100);
  });

  it("keeps the documented mid-range score for a single in-focus listing", () => {
    expect(
      scoreCompanyPreEnrich({
        icpStatus: "pass",
        hiringSignals: {},
        domainConfidence: "low",
        listings: [{ location: "West Palm Beach, FL" }],
        geoSettings,
        hrOnlyDeprioritize: false,
      }),
    ).toBe(45);
  });

  it("still applies the ICP-fail deprioritisation on the job path", () => {
    expect(
      scoreCompanyPreEnrich({
        icpStatus: "fail",
        hiringSignals: { reposted_role: 3 },
        domainConfidence: "high",
        listings: [{ location: "West Palm Beach, FL" }],
        geoSettings,
        hrOnlyDeprioritize: false,
      }),
    ).toBe(0);
  });
});
