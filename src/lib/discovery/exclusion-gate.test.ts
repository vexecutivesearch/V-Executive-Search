import { describe, expect, it } from "vitest";
import {
  describeGateRejections,
  evaluateDiscoveryGate,
  gateReasonLabel,
  isGovernmentEmployer,
  isPublicEducation,
  isStaffingOrRecruiting,
  partitionByGate,
  summarizeGateReasons,
  ENTERPRISE_REVENUE_MIN,
  type DiscoveryGateInput,
} from "./exclusion-gate";
import { matchEnterpriseDomain, normalizeHost } from "./enterprise-domains";

function company(overrides: Partial<DiscoveryGateInput> = {}): DiscoveryGateInput {
  return {
    name: "Palmetto Roofing Co",
    domain: "palmettoroofing.com",
    industry: "construction",
    employeeCount: 60,
    annualRevenue: null,
    publiclyTradedSymbol: null,
    vertical: "construction",
    ...overrides,
  };
}

describe("evaluateDiscoveryGate — employee bands", () => {
  it("accepts a company inside the vertical band", () => {
    const decision = evaluateDiscoveryGate(company());
    expect(decision.verdict).toBe("accept");
    expect(decision.reason).toBe("within_band");
  });

  it.each([
    ["legal", 500, "accept"],
    ["legal", 501, "reject"],
    ["legal", 499, "accept"],
    ["legal", 10, "accept"],
    ["legal", 9, "review"],
    ["construction", 750, "accept"],
    ["construction", 751, "reject"],
    ["construction", 749, "accept"],
    ["construction", 15, "accept"],
    ["construction", 14, "review"],
    ["finance_accounting", 750, "accept"],
    ["finance_accounting", 751, "reject"],
    ["finance_accounting", 25, "accept"],
    ["finance_accounting", 24, "review"],
    ["general_professional", 750, "accept"],
    ["general_professional", 751, "reject"],
  ])("%s at %i employees is %s", (vertical, employeeCount, verdict) => {
    const decision = evaluateDiscoveryGate(
      company({ vertical, employeeCount, industry: null }),
    );
    expect(decision.verdict).toBe(verdict);
  });

  it("reports the band in the detail of an over-max rejection", () => {
    const decision = evaluateDiscoveryGate(
      company({ vertical: "legal", employeeCount: 4200, industry: null }),
    );
    expect(decision.reason).toBe("employees_above_max");
    expect(decision.detail).toContain("4,200");
    expect(decision.detail).toContain("500");
  });

  it("falls back to the default 20–500 band with no vertical", () => {
    expect(
      evaluateDiscoveryGate(
        company({ vertical: null, employeeCount: 501, industry: null }),
      ).verdict,
    ).toBe("reject");
    expect(
      evaluateDiscoveryGate(
        company({ vertical: null, employeeCount: 500, industry: null }),
      ).verdict,
    ).toBe("accept");
  });
});

describe("evaluateDiscoveryGate — unknown size fails closed to review", () => {
  it("never auto-accepts a company with no headcount", () => {
    const decision = evaluateDiscoveryGate(company({ employeeCount: null }));
    expect(decision.verdict).toBe("review");
    expect(decision.reason).toBe("size_unknown");
  });

  it("does not drop it either — a small local firm often has no headcount", () => {
    const decision = evaluateDiscoveryGate(
      company({ name: "Vega & Sons Plumbing", employeeCount: undefined }),
    );
    expect(decision.verdict).not.toBe("reject");
  });

  it("still rejects a staffing agency whose headcount is unknown", () => {
    const decision = evaluateDiscoveryGate(
      company({
        name: "Coastal Staffing Partners",
        domain: "coastalstaffingpartners.com",
        employeeCount: null,
      }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("staffing_agency");
  });

  it("still rejects an enterprise domain whose headcount is unknown", () => {
    const decision = evaluateDiscoveryGate(
      company({
        name: "Deloitte Tax LLP",
        domain: "deloitte.com",
        employeeCount: null,
      }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("enterprise_domain");
  });

  it("still rejects a publicly traded company whose headcount is unknown", () => {
    const decision = evaluateDiscoveryGate(
      company({
        name: "Regional Holdings",
        domain: "regionalholdings.com",
        employeeCount: null,
        publiclyTradedSymbol: "RGHL",
      }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("publicly_traded");
  });
});

describe("evaluateDiscoveryGate — enterprise signals beat a small headcount", () => {
  it("rejects a Fortune 500 subsidiary reporting a small local office", () => {
    const decision = evaluateDiscoveryGate(
      company({
        name: "Aerotek — Boca Raton",
        domain: "careers.aerotek.com",
        industry: "construction",
        employeeCount: 42,
      }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("staffing_agency");
  });

  it("rejects a subsidiary that carries the parent's revenue", () => {
    const decision = evaluateDiscoveryGate(
      company({
        name: "Meridian Mechanical Southeast",
        domain: "meridianmechanicalse.com",
        employeeCount: 55,
        annualRevenue: 4_200_000_000,
      }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("revenue_above_max");
  });

  it("keeps a healthy mid-market firm just under the revenue ceiling", () => {
    const decision = evaluateDiscoveryGate(
      company({ annualRevenue: ENTERPRISE_REVENUE_MIN - 1 }),
    );
    expect(decision.verdict).toBe("accept");
  });

  it("rejects exactly at the revenue ceiling", () => {
    expect(
      evaluateDiscoveryGate(company({ annualRevenue: ENTERPRISE_REVENUE_MIN }))
        .reason,
    ).toBe("revenue_above_max");
  });

  it("treats a ticker as proof of a public company", () => {
    const decision = evaluateDiscoveryGate(
      company({ name: "Comfort Systems Regional", publiclyTradedSymbol: "FIX" }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("publicly_traded");
  });

  it("ignores an empty ticker string", () => {
    expect(
      evaluateDiscoveryGate(company({ publiclyTradedSymbol: "  " })).verdict,
    ).toBe("accept");
  });
});

describe("evaluateDiscoveryGate — staffing and recruiting", () => {
  it.each([
    "Coastal Staffing Group",
    "Summit Recruiting LLC",
    "Apex Recruitment Partners",
    "Blue Sky Talent Solutions",
    "Landmark Executive Search",
    "Gulfstream Search Partners",
    "Atlantic Personnel Services",
    "Sunbelt Workforce Solutions",
    "First Choice Employment Agency",
    "Tri-County Headhunters",
    "Peak HR Solutions",
    "Bayside Temp Staffing",
    "Manpower of Palm Beach",
  ])("rejects %s", (name) => {
    const decision = evaluateDiscoveryGate(
      company({ name, domain: null, industry: null }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("staffing_agency");
  });

  it("rejects on the provider industry taxonomy alone", () => {
    const decision = evaluateDiscoveryGate(
      company({
        name: "Bright Path Consulting",
        domain: "brightpathconsulting.com",
        industry: "staffing & recruiting",
      }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("staffing_agency");
  });

  it("rejects the operator's own kind of firm", () => {
    expect(
      isStaffingOrRecruiting({ name: "V Executive Search" }),
    ).not.toBeNull();
  });

  it.each([
    "Talent Design Group",
    "Search & Rescue Restoration",
    "Talent Creative Studio",
    "Deep Search Analytics",
    "Talent Roofing Company",
    "Sterling Talent Winery",
  ])("keeps %s — 'talent' or 'search' alone is not a staffing signal", (name) => {
    expect(isStaffingOrRecruiting({ name })).toBeNull();
  });

  it("keeps an HR consulting firm that is not an agency", () => {
    expect(
      isStaffingOrRecruiting({ name: "Harborview HR Consulting" }),
    ).toBeNull();
  });
});

describe("evaluateDiscoveryGate — government and public sector", () => {
  it.each([
    ["City of Boca Raton", null],
    ["Palm Beach County Government", null],
    ["State of Florida Department of Transportation", null],
    ["Broward Sheriffs Office", null],
    ["Miami-Dade Housing Authority", null],
    ["Southeast Water Management District", null],
    ["Anytown Municipal Services", null],
  ])("rejects %s", (name, domain) => {
    const decision = evaluateDiscoveryGate(
      company({ name, domain, industry: null }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("government");
  });

  it("rejects a .gov domain regardless of the name", () => {
    const decision = evaluateDiscoveryGate(
      company({ name: "Parks and Recreation", domain: "myboca.gov" }),
    );
    expect(decision.verdict).toBe("reject");
    expect(decision.reason).toBe("government");
  });

  it("rejects a .mil domain", () => {
    expect(
      isGovernmentEmployer({ name: "Base Support", domain: "navy.mil" }),
    ).not.toBeNull();
  });

  it("rejects on the government industry taxonomy", () => {
    expect(
      isGovernmentEmployer({
        name: "Regional Planning Council",
        domain: "rpc.org",
        industry: "government administration",
      }),
    ).not.toBeNull();
  });

  it("does not treat a private firm serving government as government", () => {
    expect(
      isGovernmentEmployer({
        name: "Citywide Electric Contractors",
        domain: "citywideelectric.com",
        industry: "construction",
      }),
    ).toBeNull();
  });

  it("rejects public education employers", () => {
    expect(
      isPublicEducation({ name: "Palm Beach County School District" }),
    ).not.toBeNull();
    expect(isPublicEducation({ name: "Katy ISD" })).not.toBeNull();
    expect(
      isPublicEducation({ name: "Broward College", industry: "higher education" }),
    ).not.toBeNull();
  });

  it("does not treat a trade school vendor as public education", () => {
    expect(isPublicEducation({ name: "Rooftop Training Partners" })).toBeNull();
  });
});

describe("allowLargeCompanies escape hatch", () => {
  const oversized = company({
    name: "Statewide General Contractors",
    domain: "statewidegc.com",
    employeeCount: 2400,
  });

  it("is off by default", () => {
    expect(evaluateDiscoveryGate(oversized).verdict).toBe("reject");
  });

  it("downgrades an over-max headcount to review when opted in", () => {
    const decision = evaluateDiscoveryGate(oversized, {
      allowLargeCompanies: true,
    });
    expect(decision.verdict).toBe("review");
    expect(decision.reason).toBe("employees_above_max");
  });

  it("does not unlock staffing, government, or enterprise rejections", () => {
    const options = { allowLargeCompanies: true };
    expect(
      evaluateDiscoveryGate(company({ name: "Elite Staffing" }), options).verdict,
    ).toBe("reject");
    expect(
      evaluateDiscoveryGate(company({ name: "City of Tampa" }), options).verdict,
    ).toBe("reject");
    expect(
      evaluateDiscoveryGate(company({ domain: "kochind.com" }), options).verdict,
    ).toBe("reject");
    expect(
      evaluateDiscoveryGate(
        company({ publiclyTradedSymbol: "AAPL" }),
        options,
      ).verdict,
    ).toBe("reject");
  });
});

describe("partitionByGate and reporting", () => {
  const batch: DiscoveryGateInput[] = [
    company({ name: "Palmetto Roofing Co" }),
    company({ name: "Coastal Staffing Group", domain: "coastalstaffing.com" }),
    company({ name: "City of Boca Raton", domain: "myboca.gov" }),
    company({ name: "Statewide GC", employeeCount: 5000 }),
    company({ name: "Vega Plumbing", employeeCount: null }),
  ];

  it("splits a batch into accept, flag, and reject", () => {
    const partition = partitionByGate(batch, (c) => c);
    expect(partition.accepted.map((c) => c.name)).toEqual(["Palmetto Roofing Co"]);
    expect(partition.flagged.map((f) => f.item.name)).toEqual(["Vega Plumbing"]);
    expect(partition.rejected.map((r) => r.item.name)).toEqual([
      "Coastal Staffing Group",
      "City of Boca Raton",
      "Statewide GC",
    ]);
  });

  it("counts rejections by reason", () => {
    const partition = partitionByGate(batch, (c) => c);
    expect(summarizeGateReasons(partition.rejected.map((r) => r.decision))).toEqual({
      staffing_agency: 1,
      government: 1,
      employees_above_max: 1,
    });
  });

  it("renders a summary line the operator can act on", () => {
    expect(
      describeGateRejections({
        employees_above_max: 7,
        staffing_agency: 3,
        government: 2,
      }),
    ).toBe(
      "12 rejected before review: 7 too large, 3 staffing or recruiting firm, 2 government / public sector.",
    );
  });

  it("returns null when nothing was rejected", () => {
    expect(describeGateRejections({})).toBeNull();
  });

  it("labels every reason", () => {
    const reasons = [
      "within_band",
      "size_unknown",
      "employees_below_min",
      "employees_above_max",
      "government",
      "public_education",
      "staffing_agency",
      "publicly_traded",
      "enterprise_domain",
      "revenue_above_max",
    ] as const;
    for (const reason of reasons) {
      expect(gateReasonLabel(reason)).toBeTruthy();
    }
  });
});

describe("enterprise domain matching", () => {
  it("matches the registrable domain and any subdomain", () => {
    expect(matchEnterpriseDomain("aerotek.com")?.kind).toBe("staffing");
    expect(matchEnterpriseDomain("careers.aerotek.com")?.domain).toBe(
      "aerotek.com",
    );
    expect(matchEnterpriseDomain("https://www.deloitte.com/us/en")?.kind).toBe(
      "enterprise",
    );
  });

  it("does not match a lookalike that merely contains the string", () => {
    expect(matchEnterpriseDomain("myaerotek.com")).toBeNull();
    expect(matchEnterpriseDomain("aerotek.com.mx")).toBeNull();
    expect(matchEnterpriseDomain("notdeloitte.com")).toBeNull();
  });

  it("handles missing and malformed input", () => {
    expect(matchEnterpriseDomain(null)).toBeNull();
    expect(matchEnterpriseDomain("")).toBeNull();
    expect(matchEnterpriseDomain("   ")).toBeNull();
    expect(normalizeHost("HTTPS://WWW.Example.com:443/path?q=1")).toBe(
      "example.com",
    );
  });
});
