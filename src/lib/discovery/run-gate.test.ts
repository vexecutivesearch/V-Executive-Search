import { describe, expect, it } from "vitest";
import { gateOrganizations } from "@/lib/discovery/run";
import { mergeQuantified } from "@/lib/discovery/sources/apollo-quantify";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";

function org(
  overrides: Partial<DiscoveredOrganization> & { name: string },
): DiscoveredOrganization {
  return {
    domain: null,
    websiteUrl: null,
    industry: null,
    estimatedEmployees: 40,
    phone: null,
    linkedinUrl: null,
    foundedYear: null,
    city: "Boca Raton",
    state: "Florida",
    domainConfidence: "high",
    annualRevenue: null,
    publiclyTradedSymbol: null,
    ...overrides,
  };
}

describe("gateOrganizations — provider payload to gate decision", () => {
  it("keeps in-band companies and drops the rest of an Apollo page", () => {
    const page = [
      org({ name: "Vega Law Group", domain: "vegalaw.com", estimatedEmployees: 40 }),
      org({ name: "Coastal Staffing Group", domain: "coastalstaffing.com" }),
      org({ name: "City of Boca Raton", domain: "myboca.gov" }),
      org({ name: "Mega Legal LLP", domain: "megalegal.com", estimatedEmployees: 9000 }),
      org({ name: "Small Firm PA", domain: "smallfirm.com", estimatedEmployees: null }),
    ];

    const { kept, rejected } = gateOrganizations(page, "legal");

    expect(kept.map((o) => o.name)).toEqual(["Vega Law Group", "Small Firm PA"]);
    expect(rejected.map((d) => d.reason)).toEqual([
      "staffing_agency",
      "government",
      "employees_above_max",
    ]);
  });

  it("falls back to the website URL when Apollo has no primary domain", () => {
    const { rejected } = gateOrganizations(
      [
        org({
          name: "Southeast Regional Office",
          domain: null,
          websiteUrl: "https://www.deloitte.com/us/en/offices",
        }),
      ],
      "finance_accounting",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("enterprise_domain");
  });

  it("reads the revenue and ticker signals off the payload", () => {
    const { rejected } = gateOrganizations(
      [
        org({
          name: "Northline Mechanical",
          domain: "northlinemech.com",
          estimatedEmployees: 80,
          annualRevenue: 6_500_000_000,
        }),
        org({
          name: "Harbor Industrial",
          domain: "harborind.com",
          estimatedEmployees: 200,
          publiclyTradedSymbol: "HBR",
        }),
      ],
      "construction",
    );
    expect(rejected.map((d) => d.reason)).toEqual([
      "revenue_above_max",
      "publicly_traded",
    ]);
  });

  it("uses the vertical's band, not a global one", () => {
    const page = [org({ name: "Midsize Firm", domain: "midsize.com", estimatedEmployees: 600 })];
    expect(gateOrganizations(page, "legal").rejected).toHaveLength(1);
    expect(gateOrganizations(page, "construction").rejected).toHaveLength(0);
  });

  it("keeps oversized companies for review only when explicitly allowed", () => {
    const page = [org({ name: "Big GC", domain: "biggc.com", estimatedEmployees: 4000 })];
    expect(gateOrganizations(page, "construction", false).kept).toHaveLength(0);
    expect(gateOrganizations(page, "construction", true).kept).toHaveLength(1);
  });

  /*
   * The fail-open a live trace caught, asserted at the PIPELINE call site
   * rather than only on the `gateInputFor` adapter.
   *
   * A staffing agency with a polished Google Business Profile calls itself a
   * "Business management consultant". Display precedence never overwrites a
   * real value with a second provider's, so that Google category stays on
   * `industry` even after Apollo says "staffing & recruiting". A gate handed
   * `org.industry` therefore sees a consultancy at 22 employees — inside the
   * construction band — and ACCEPTS a company the operator ruled out.
   *
   * `gateInputFor` alone is not enough to prevent this: it was already correct
   * and already covered when `gateOrganizations` was still reading the display
   * value. Only a test on the function the run actually calls catches it.
   */
  it("judges a quantified company on Apollo's taxonomy, not its display industry", () => {
    const agency = mergeQuantified(
      org({
        name: "Meridian Advisory Group",
        domain: "meridianadvisory.com",
        industry: "Business management consultant",
        estimatedEmployees: null,
      }),
      org({
        name: "Meridian Advisory Group",
        domain: "meridianadvisory.com",
        industry: "staffing & recruiting",
        estimatedEmployees: 22,
      }),
      { domain: "meridianadvisory.com" },
    );

    const { kept, rejected } = gateOrganizations([agency], "construction");

    expect(rejected.map((d) => d.reason)).toEqual(["staffing_agency"]);
    expect(kept).toHaveLength(0);
    // The display label is untouched — the gate reads a different value, it
    // does not rewrite the one the operator sees.
    expect(agency.industry).toBe("Business management consultant");
  });

  it("still gates on the source's industry when Apollo had no record for it", () => {
    const unmatched = mergeQuantified(
      org({
        name: "Peak Staffing Partners",
        domain: "peakstaffing.com",
        industry: "staffing & recruiting",
      }),
      null,
      { domain: "peakstaffing.com" },
    );

    expect(gateOrganizations([unmatched], "construction").rejected).toEqual([
      expect.objectContaining({ reason: "staffing_agency" }),
    ]);
  });

  it("carries the quantification through the gate so provenance survives", () => {
    const quantified = mergeQuantified(
      org({ name: "Northline Mechanical", domain: "northlinemech.com", estimatedEmployees: null }),
      org({ name: "Northline Mechanical", domain: "northlinemech.com", estimatedEmployees: 80 }),
      { domain: "northlinemech.com" },
    );

    const { kept } = gateOrganizations([quantified], "construction");

    expect(kept).toHaveLength(1);
    expect(kept[0].quantification.fields.estimatedEmployees).toBe("apollo");
  });
});
