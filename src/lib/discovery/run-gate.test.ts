import { describe, expect, it } from "vitest";
import { gateOrganizations } from "@/lib/discovery/run";
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
});
