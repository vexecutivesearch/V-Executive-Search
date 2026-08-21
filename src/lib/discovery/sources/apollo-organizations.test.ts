import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSearchOptions } from "@/lib/domain-resolver";

/*
 * Proves the CompanyDiscoverySource interface is not shaped around SerpApi:
 * Apollo — which bills per page of up to 100 rows, knows headcount, and pages
 * to 50,000 records — satisfies the same contract as a 20-results-per-search
 * Maps sweep.
 */

const searchOrganizations = vi.fn();

vi.mock("@/lib/domain-resolver", () => ({ searchOrganizations }));

function apolloResult(count: number, totalEntries: number | null = 500) {
  return {
    organizations: Array.from({ length: count }, (_, i) => ({
      name: `Firm ${i}`,
      domain: `firm${i}.com`,
      websiteUrl: `https://firm${i}.com`,
      industry: "law practice",
      estimatedEmployees: 40,
      phone: null,
      linkedinUrl: null,
      foundedYear: null,
      city: "West Palm Beach",
      state: "FL",
      domainConfidence: "high" as const,
      annualRevenue: null,
      publiclyTradedSymbol: null,
    })),
    page: 1,
    perPage: 100,
    totalEntries,
    totalPages: totalEntries == null ? null : Math.ceil(totalEntries / 100),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("apolloOrganizationSource", () => {
  it("declines an unknown vertical and accepts the configured ones", async () => {
    const { apolloOrganizationSource } = await import(
      "@/lib/discovery/sources/apollo-organizations"
    );
    const source = apolloOrganizationSource({ apiKey: "k" });
    expect(source.supportsVertical("legal")).toBe(true);
    expect(source.supportsVertical("construction")).toBe(true);
    expect(source.supportsVertical("not_a_vertical")).toBe(false);
  });

  /*
   * Apollo bills 1 credit for a page of up to 100 organizations, so asking for
   * 25 pays a whole credit for a quarter of a page. The adapter always requests
   * the maximum and slices locally.
   */
  it("always requests the full 100-row page and slices to the run limit", async () => {
    searchOrganizations.mockResolvedValueOnce(apolloResult(100));
    const { apolloOrganizationSource } = await import(
      "@/lib/discovery/sources/apollo-organizations"
    );

    const outcome = await apolloOrganizationSource({ apiKey: "k" }).discover({
      vertical: "legal",
      market: "Palm Beach County, Florida",
      limit: 25,
    });

    const options = searchOrganizations.mock.calls[0][0] as OrganizationSearchOptions;
    expect(options.perPage).toBe(100);
    expect(options.employeeRange).toBe("10,500");
    expect(options.locations).toEqual(["Palm Beach County, Florida"]);
    expect(outcome.organizations).toHaveLength(25);
    expect(outcome.unitsSpent).toBe(1);
  });

  it("bills one credit per page regardless of how many rows came back", async () => {
    searchOrganizations.mockResolvedValueOnce(apolloResult(3));
    const { apolloOrganizationSource } = await import(
      "@/lib/discovery/sources/apollo-organizations"
    );

    const outcome = await apolloOrganizationSource({ apiKey: "k" }).discover({
      vertical: "legal",
      market: "Tampa, Florida",
      limit: 25,
    });
    expect(outcome.unitsSpent).toBe(1);
  });

  /*
   * Omitting the headcount filter is how the pipeline surfaces companies Apollo
   * has no size for — exactly the small firms the operator wants.
   */
  it("passes a null employee range through unchanged", async () => {
    searchOrganizations.mockResolvedValueOnce(apolloResult(10));
    const { apolloOrganizationSource } = await import(
      "@/lib/discovery/sources/apollo-organizations"
    );

    await apolloOrganizationSource({ apiKey: "k", employeeRange: null }).discover({
      vertical: "legal",
      market: "Tampa, Florida",
      limit: 25,
    });

    const options = searchOrganizations.mock.calls[0][0] as OrganizationSearchOptions;
    expect(options.employeeRange).toBeNull();
  });

  it("reports pool exhaustion on a short page", async () => {
    searchOrganizations.mockResolvedValueOnce(apolloResult(42));
    const { apolloOrganizationSource } = await import(
      "@/lib/discovery/sources/apollo-organizations"
    );

    const outcome = await apolloOrganizationSource({ apiKey: "k" }).discover({
      vertical: "legal",
      market: "Tampa, Florida",
      limit: 100,
    });
    expect(outcome.poolExhausted).toBe(true);
  });

  it("reports pool exhaustion once the page offset passes total_entries", async () => {
    searchOrganizations.mockResolvedValueOnce(apolloResult(100, 200));
    const { apolloOrganizationSource } = await import(
      "@/lib/discovery/sources/apollo-organizations"
    );

    const outcome = await apolloOrganizationSource({
      apiKey: "k",
      page: 2,
    }).discover({
      vertical: "legal",
      market: "Tampa, Florida",
      limit: 100,
    });
    expect(outcome.poolExhausted).toBe(true);
  });

  it("declares its billing unit as a credit, not a search", async () => {
    const { apolloOrganizationSource } = await import(
      "@/lib/discovery/sources/apollo-organizations"
    );
    expect(apolloOrganizationSource({ apiKey: "k" }).billingUnit).toBe("credit");
  });
});
