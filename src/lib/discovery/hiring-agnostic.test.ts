import { describe, expect, it } from "vitest";
import {
  buildOrganizationSearchBody,
  JOB_ACTIVITY_SEARCH_KEYS,
} from "@/lib/domain-resolver";
import { matchExistingCompany, preferredIndustry } from "@/lib/discovery/run";
import { normalizeCompanyKey } from "@/lib/company-name";
import { selectDiscoveryCandidates } from "@/lib/discovery/candidates";
import { summarizeJobSignals } from "@/lib/discovery/job-signals";
import { scoreCompanyFirst } from "@/lib/lead-score";
import {
  apolloEmployeeRange,
  keywordTagsForVertical,
  verticalIds,
} from "@/lib/discovery/verticals";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";

/**
 * The operator's requirement: find companies matching the vertical, market and
 * size band WHETHER OR NOT they are currently hiring. A law firm with no open
 * roles is a valid prospect. So no part of discovery may treat job activity as
 * a filter, and the absence of job activity may not push a company out of
 * sight.
 */
describe("the Apollo organization search never constrains on job activity", () => {
  const body = buildOrganizationSearchBody({
    locations: ["Palm Beach County, Florida"],
    keywordTags: keywordTagsForVertical("legal"),
    employeeRange: apolloEmployeeRange("legal"),
    page: 1,
    perPage: 25,
  });

  it("sends only what/where/how-big filters", () => {
    expect(Object.keys(body).sort()).toEqual([
      "organization_locations",
      "organization_num_employees_ranges",
      "page",
      "per_page",
      "q_organization_keyword_tags",
    ]);
  });

  it("carries none of Apollo's job-activity parameters", () => {
    for (const key of JOB_ACTIVITY_SEARCH_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("stays clean for every vertical, sized and unknown-headcount passes", () => {
    for (const vertical of verticalIds()) {
      for (const employeeRange of [apolloEmployeeRange(vertical), null]) {
        const built = buildOrganizationSearchBody({
          locations: ["Miami, Florida"],
          keywordTags: keywordTagsForVertical(vertical),
          employeeRange,
          perPage: 100,
        });
        for (const key of JOB_ACTIVITY_SEARCH_KEYS) {
          expect(built).not.toHaveProperty(key);
        }
      }
    }
  });

  it("omits the headcount filter entirely on the unknown-size pass", () => {
    const built = buildOrganizationSearchBody({
      locations: ["Tampa, Florida"],
      keywordTags: ["law firm"],
      employeeRange: null,
    });
    expect(built).not.toHaveProperty("organization_num_employees_ranges");
  });
});

describe("a company with zero job activity survives discovery", () => {
  function org(overrides: Partial<DiscoveredOrganization>): DiscoveredOrganization {
    return {
      name: "Quiet Law Offices",
      domain: "quietlaw.com",
      websiteUrl: "https://quietlaw.com",
      industry: "law practice",
      estimatedEmployees: 14,
      phone: "+1 561-555-0100",
      linkedinUrl: "https://linkedin.com/company/quietlaw",
      foundedYear: 1998,
      city: "West Palm Beach",
      state: "Florida",
      domainConfidence: "high",
      ...overrides,
    };
  }

  it("is selected as a candidate — nothing in selection reads job data", () => {
    const { candidates } = selectDiscoveryCandidates({
      vertical: "legal",
      sized: [org({}), org({ name: "Busy Law", domain: "busylaw.com" })],
      unknownSize: [],
      limit: 25,
    });
    expect(candidates.map((c) => c.name)).toContain("Quiet Law Offices");
    expect(candidates).toHaveLength(2);
  });

  it("summarises to no job signal without erroring or excluding", () => {
    const signal = summarizeJobSignals([]);
    expect(signal.openPositions).toBe(0);
    expect(signal.label).toBeNull();
  });

  it("scores in the same band as an identical company that is hiring", () => {
    const shared = {
      vertical: "legal",
      icpStatus: "pass" as const,
      estimatedEmployees: 14,
      domainConfidence: "high",
      hasPhone: true,
      hasLinkedIn: true,
    };
    const quiet = scoreCompanyFirst({
      ...shared,
      hiringSignals: {},
      openPositions: 0,
    });
    const hiring = scoreCompanyFirst({
      ...shared,
      hiringSignals: { reposted_role: 3, multiple_openings: 4 },
      openPositions: 6,
    });

    expect(quiet).toBeGreaterThanOrEqual(75);
    // Job activity is a tiebreaker, not the thing that decides the page-1 cut.
    expect(hiring - quiet).toBeLessThanOrEqual(6);
  });

  it("outranks a hiring company that is out of band or flagged", () => {
    const quiet = scoreCompanyFirst({
      vertical: "legal",
      icpStatus: "pass",
      estimatedEmployees: 14,
      domainConfidence: "high",
      hasPhone: true,
      hasLinkedIn: true,
      hiringSignals: {},
      openPositions: 0,
    });
    const hiringStaffingAgency = scoreCompanyFirst({
      vertical: "legal",
      icpStatus: "pass",
      estimatedEmployees: 14,
      domainConfidence: "high",
      hasPhone: true,
      hasLinkedIn: true,
      hiringSignals: { reposted_role: 3 },
      openPositions: 8,
      exclusionFlags: ["staffing_agency"],
    });
    expect(quiet).toBeGreaterThan(hiringStaffingAgency);
  });
});

/**
 * Job counts in the review queue come from the ATTACH step — `job_listings`
 * joined by `company_id`, where the company_id comes from this dedupe match.
 * A wrong match hands one company's open roles to another, which is how a firm
 * that has never posted a job shows "2 open positions".
 */
describe("job-signal attach cannot fire on a loose name match", () => {
  type Row = NonNullable<ReturnType<typeof matchExistingCompany>>;

  function row(name: string, domain: string | null): Row {
    return {
      id: `id-${name}`,
      name,
      domain,
      status: "new",
      vertical: null,
      reviewStatus: null,
      domainConfidence: "low",
      industry: null,
      estimatedEmployees: null,
      phone: null,
      linkedinUrl: null,
      city: null,
      state: null,
    } as Row;
  }

  function indexOf(rows: Row[]) {
    const byDomain = new Map<string, Row>();
    const byName = new Map<string, Row>();
    for (const r of rows) {
      if (r.domain) byDomain.set(r.domain.toLowerCase(), r);
      const key = normalizeCompanyKey(r.name);
      if (key) byName.set(key, r);
    }
    return { byDomain, byName };
  }

  it("refuses a name match when the two rows have different domains", () => {
    // Both normalise to "ray thomas" — the suffix stripper eats Group and Co.
    const index = indexOf([row("Ray Thomas Co", "raythomasplumbing.com")]);
    expect(
      matchExistingCompany(
        { name: "Ray Thomas Group", domain: "raythomasgroup.com" },
        index,
      ),
    ).toBeNull();
  });

  it("refuses a name match on a key the suffix stripper reduced to one word", () => {
    const index = indexOf([row("Smith Holdings", null)]);
    expect(normalizeCompanyKey("Smith Group")).toBe("smith");
    expect(
      matchExistingCompany({ name: "Smith Group", domain: null }, index),
    ).toBeNull();
  });

  it("still matches a single-word company that lost nothing to stripping", () => {
    const index = indexOf([row("Salesforce", null)]);
    expect(
      matchExistingCompany({ name: "Salesforce", domain: "salesforce.com" }, index)
        ?.id,
    ).toBe("id-Salesforce");
  });

  it("still merges the real duplicate the scrape left without a domain", () => {
    const index = indexOf([row("Vega Law Group, LLC", null)]);
    expect(
      matchExistingCompany({ name: "Vega Law", domain: "vegalaw.com" }, index)?.id,
    ).toBe("id-Vega Law Group, LLC");
  });

  it("still prefers an exact domain match over any name reasoning", () => {
    const index = indexOf([
      row("Vega Law of Miami", "vegalaw.com"),
      row("Vega Law", null),
    ]);
    expect(
      matchExistingCompany({ name: "Vega Law", domain: "vegalaw.com" }, index)?.id,
    ).toBe("id-Vega Law of Miami");
  });
});

describe("Apollo's real industry replaces the pipeline rollup placeholder", () => {
  it("overwrites a coarse sector label", () => {
    expect(
      preferredIndustry("Professional & Business Services", "marketing & advertising"),
    ).toBe("marketing & advertising");
    expect(preferredIndustry("Other", "law practice")).toBe("law practice");
  });

  it("never overwrites a real industry already on file", () => {
    expect(preferredIndustry("law practice", "legal services")).toBe(
      "law practice",
    );
  });

  it("keeps what it has when Apollo returned nothing", () => {
    expect(preferredIndustry("Professional & Business Services", null)).toBe(
      "Professional & Business Services",
    );
    expect(preferredIndustry(null, null)).toBeNull();
  });
});
