import { describe, expect, it } from "vitest";
import type { JobListing } from "@/lib/db/schema";
import {
  buildHotListings,
  formatHotListingHeadline,
  type HotListingCompanyInput,
} from "@/lib/hot-listings";

function listing(
  overrides: Partial<JobListing> & { title: string },
): JobListing {
  return {
    id: overrides.id ?? "job-1",
    companyId: "co-1",
    title: overrides.title,
    board: overrides.board ?? "indeed",
    url: overrides.url ?? "https://example.com/job",
    location: overrides.location ?? "Stuart, FL",
    searchName: overrides.searchName ?? "Market scan",
    salaryMin: overrides.salaryMin ?? null,
    salaryMax: overrides.salaryMax ?? null,
    salaryCurrency: overrides.salaryCurrency ?? "USD",
    salaryText: overrides.salaryText ?? null,
    postedAt: overrides.postedAt ?? null,
    posterName: null,
    posterTitle: null,
    posterLinkedinUrl: null,
    urlFingerprint: "fp",
    sightingsCount: 1,
    firstSeenAt: overrides.firstSeenAt ?? new Date("2026-07-12T12:00:00Z"),
    lastSeenAt: overrides.lastSeenAt ?? new Date("2026-07-12T12:00:00Z"),
    lastSeenRunDate: "2026-07-12",
    archivedAt: null,
    createdAt: new Date("2026-07-12T12:00:00Z"),
  };
}

function company(
  overrides: Partial<HotListingCompanyInput> & { name: string },
): HotListingCompanyInput {
  return {
    id: overrides.id ?? "co-1",
    name: overrides.name,
    domain: overrides.domain ?? "example.com",
    industry: overrides.industry ?? "law practice",
    estimatedEmployees:
      "estimatedEmployees" in overrides
        ? overrides.estimatedEmployees ?? null
        : 200,
    leadScore: overrides.leadScore ?? 80,
    firstSeen: overrides.firstSeen ?? "2026-07-12",
    contacts: overrides.contacts ?? [],
    jobListings: overrides.jobListings ?? [],
  };
}

describe("formatHotListingHeadline", () => {
  it("formats with salary", () => {
    expect(
      formatHotListingHeadline({
        companyName: "ABC Law Firm",
        role: "Litigation Paralegal",
        locationLabel: "Stuart, FL",
        salaryAnnual: 90000,
      }),
    ).toBe(
      "ABC Law Firm is hiring a Litigation Paralegal in Stuart, FL at $90,000 a year.",
    );
  });

  it("omits salary gracefully — no dangling at", () => {
    expect(
      formatHotListingHeadline({
        companyName: "Acme Marketing",
        role: "Marketing Manager",
        locationLabel: "Boca Raton, FL",
        salaryAnnual: null,
      }),
    ).toBe("Acme Marketing is hiring a Marketing Manager in Boca Raton, FL.");
  });
});

describe("buildHotListings", () => {
  it("includes a Legal paralegal at a mid-size in-geo law firm", () => {
    const { listings, hidden } = buildHotListings(
      [
        company({
          name: "ABC Law Firm",
          industry: "law practice",
          estimatedEmployees: 200,
          jobListings: [
            listing({
              title: "Litigation Paralegal",
              location: "Stuart, FL",
              salaryMax: 90000,
            }),
          ],
        }),
      ],
      { listDate: "2026-07-12" },
    );

    expect(listings).toHaveLength(1);
    expect(listings[0].roleFamily).toBe("Legal");
    expect(listings[0].headline).toBe(
      "ABC Law Firm is hiring a Litigation Paralegal in Stuart, FL at $90,000 a year.",
    );
    expect(hidden.sizeUnknown).toBe(0);
  });

  it("excludes barista at franchise retail (wrong family + excluded sector)", () => {
    const { listings } = buildHotListings([
      company({
        name: "Crumbl Cookies Franchises",
        industry: "restaurants",
        estimatedEmployees: 120,
        jobListings: [
          listing({
            title: "Barista",
            location: "West Palm Beach, FL",
          }),
        ],
      }),
    ]);
    expect(listings).toHaveLength(0);
  });

  it("excludes Legal role at a 5,000-employee corp (too big)", () => {
    const { listings } = buildHotListings([
      company({
        name: "Mega Corp Legal",
        industry: "law practice",
        estimatedEmployees: 5000,
        jobListings: [
          listing({
            title: "Corporate Counsel",
            location: "Stuart, FL",
            salaryMax: 150000,
          }),
        ],
      }),
    ]);
    expect(listings).toHaveLength(0);
  });

  it("includes Marketing with no salary — sentence has no at", () => {
    const { listings } = buildHotListings([
      company({
        name: "Growth Co",
        industry: "marketing & advertising",
        estimatedEmployees: 80,
        jobListings: [
          listing({
            title: "Marketing Manager",
            location: "Delray Beach, FL",
            salaryMin: null,
            salaryMax: null,
            salaryText: null,
          }),
        ],
      }),
    ]);
    expect(listings).toHaveLength(1);
    expect(listings[0].headline).toBe(
      "Growth Co is hiring a Marketing Manager in Delray Beach, FL.",
    );
    expect(listings[0].headline.includes(" at ")).toBe(false);
  });

  it("excludes unknown company size but counts it", () => {
    const { listings, hidden } = buildHotListings([
      company({
        name: "Mystery Firm",
        industry: "law practice",
        estimatedEmployees: null,
        jobListings: [
          listing({
            title: "Litigation Paralegal",
            location: "Stuart, FL",
          }),
        ],
      }),
    ]);
    expect(listings).toHaveLength(0);
    expect(hidden.sizeUnknown).toBe(1);
  });

  it("counts below-salary when include-unknown is off", () => {
    const { listings, hidden } = buildHotListings(
      [
        company({
          name: "No Pay Posted LLC",
          industry: "law practice",
          estimatedEmployees: 100,
          jobListings: [
            listing({
              title: "Paralegal",
              location: "Stuart, FL",
            }),
          ],
        }),
      ],
      {
        filter: {
          salaryFilter: "min_salary",
          salaryMinUsd: 80000,
          includeUnknownSalary: false,
        },
      },
    );
    expect(listings).toHaveLength(0);
    expect(hidden.belowSalary).toBe(1);
  });
});
