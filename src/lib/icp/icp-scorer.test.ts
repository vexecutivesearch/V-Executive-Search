import { describe, expect, it } from "vitest";
import {
  classifyRoleType,
  icpScorer,
  isHiddenByToggles,
  normalizeListingComp,
  scoreLeadIcp,
  validateAnnotationIntegrity,
  type IcpLeadInput,
} from "./icp-scorer";
import { getIcpConfig, withFlag, ICP_FLAG_NAMES, type IcpConfig } from "./icp-config";

const config = getIcpConfig();

/** All hide-capable toggles ON — the strictest possible view. */
const ALL_HIDE_TOGGLES = {
  exclude_fortune_lists: true,
  exclude_gov_domains: true,
  exclude_known_staffing_agencies: true,
  exclude_known_large_private: true,
} as const;

function lead(
  name: string,
  title: string,
  overrides: Partial<IcpLeadInput> = {},
): IcpLeadInput {
  return {
    companyId: "test",
    companyName: name,
    domain: null,
    baseLeadScore: 60,
    listings: [{ title }],
    ...overrides,
  };
}

/** Scoring flags all ON (scoring active, still sink-don't-hide). */
function allScoringOn(): IcpConfig {
  let c = config;
  for (const flag of ICP_FLAG_NAMES) c = withFlag(c, flag, true);
  return c;
}

describe("golden adversarial set — near-misses (must keep)", () => {
  it("'Director of First Impressions' is NOT leadership and never hidden", () => {
    const role = classifyRoleType("Director of First Impressions", config);
    expect(role.roleType).not.toBe("leadership");
    const annotation = scoreLeadIcp(
      lead("Sunrise Dental Group", "Director of First Impressions"),
      allScoringOn(),
    );
    expect(isHiddenByToggles(annotation, ALL_HIDE_TOGGLES)).toBe(false);
  });

  it("'Mountain View Health' (small clinic) must NOT match hospital systems", () => {
    const annotation = scoreLeadIcp(
      lead("Mountain View Health", "Office Manager"),
      allScoringOn(),
    );
    expect(annotation.exclusionFlags).not.toContain("hospital_system");
    expect(annotation.exclusionFlags).not.toContain("large_hospital_system");
    expect(isHiddenByToggles(annotation, ALL_HIDE_TOGGLES)).toBe(false);
  });

  it("'Apple Inc' gets the fortune flag and is NOT school-matched", () => {
    const annotation = scoreLeadIcp(lead("Apple Inc", "Controller"), allScoringOn());
    expect(annotation.exclusionFlags).toContain("fortune_500");
    expect(annotation.exclusionFlags).not.toContain("school");
    expect(isHiddenByToggles(annotation, ALL_HIDE_TOGGLES)).toBe(true);
  });

  it("'Acme Partners LLC' must NOT match staffing patterns", () => {
    const annotation = scoreLeadIcp(
      lead("Acme Partners LLC", "Senior Accountant"),
      allScoringOn(),
    );
    expect(annotation.exclusionFlags).not.toContain("staffing_agency");
    expect(annotation.exclusionFlags).not.toContain("third_party_posting");
    expect(isHiddenByToggles(annotation, ALL_HIDE_TOGGLES)).toBe(false);
  });

  it("'City of Austin' gets the gov flag; 'Robert Half' the staffing flag", () => {
    const gov = scoreLeadIcp(lead("City of Austin", "HR Generalist"), allScoringOn());
    expect(gov.exclusionFlags).toContain("public_sector");
    // Pattern-based = soft: never hidden by toggles (no .gov domain here).
    expect(isHiddenByToggles(gov, ALL_HIDE_TOGGLES)).toBe(false);

    const staffing = scoreLeadIcp(lead("Robert Half", "Recruiter"), allScoringOn());
    expect(staffing.exclusionFlags).toContain("staffing_agency");
    expect(isHiddenByToggles(staffing, ALL_HIDE_TOGGLES)).toBe(true);
  });

  it("a .gov domain is deterministic and hide-eligible", () => {
    const annotation = scoreLeadIcp(
      lead("Austin Water", "Utility Billing Analyst", { domain: "austintexas.gov" }),
      allScoringOn(),
    );
    expect(annotation.exclusionFlags).toContain("gov_domain");
    expect(annotation.exclusionConfidence.gov_domain).toBe(1);
    expect(isHiddenByToggles(annotation, ALL_HIDE_TOGGLES)).toBe(true);
  });
});

describe("golden set — known-good SMB leads (must keep, must not sink)", () => {
  const goodLeads: Array<[string, string]> = [
    ["Palm Beach Ortho Group", "Practice Administrator"],
    ["Oceanside Health Partners", "Head of Talent"],
    ["Coastal Law Group LLC", "Paralegal"],
    ["Sunbelt Manufacturing Inc", "Plant Controller"],
    ["Bright Smiles Dental", "Office Manager"],
    ["Harbor Wealth Advisors", "Financial Analyst"],
    ["Blue Cypress Builders", "Project Manager"],
    ["Magnolia Veterinary Care", "Veterinarian"],
    ["Crestview HVAC Services", "Service Manager"],
    ["Lakeland Logistics LLC", "Operations Director"],
    ["Riverside Engineering Group", "Civil Engineer"],
    ["Summit Insurance Partners", "Underwriter"],
    ["Verde Landscape Design", "Account Manager"],
    ["First Coast Title Company", "Escrow Officer"],
    ["Pinewood Property Group", "Property Manager"],
    ["Atlas Aviation Services", "Director of Maintenance"],
    ["Gulfstream Marketing Co", "Marketing Manager"],
    ["Heritage Home Care", "Director of Nursing"],
    ["Ironclad Security Systems", "Systems Engineer"],
    ["Bayview Hospitality Group", "General Manager"],
    ["Seaside Accounting LLC", "Senior Accountant"],
  ];

  it("none are hidden, and all keep a healthy adjusted score", () => {
    const annotations = icpScorer(
      goodLeads.map(([name, title]) => lead(name, title)),
      allScoringOn(),
    );
    for (const annotation of annotations) {
      expect(
        isHiddenByToggles(annotation, ALL_HIDE_TOGGLES),
        `${annotation.companyName} must not be hidden`,
      ).toBe(false);
      expect(
        annotation.icpAdjustedScore,
        `${annotation.companyName} must not collapse`,
      ).toBeGreaterThanOrEqual(40);
    }
  });
});

describe("golden set — known-bad fits (flagged and sunk, never deleted)", () => {
  const badLeads: Array<[string, string, string]> = [
    ["Walmart", "Cashier", "fortune_500"],
    ["Truist", "Teller", "fortune_500"],
    ["Kaiser Permanente", "Registered Nurse", "fortune_500"],
    ["Papa Johns", "Delivery Driver", "fortune_1000"],
    ["Target", "Sales Associate", "fortune_500"],
    ["Koch Industries", "Process Engineer", "known_large_private"],
    ["Cargill", "Production Supervisor", "known_large_private"],
    ["Deloitte", "Audit Senior", "known_large_private"],
    ["Publix", "Front Service Clerk", "known_large_private"],
    ["Aerotek", "Recruiter", "staffing_agency"],
    ["Insight Global", "Account Manager", "staffing_agency"],
    ["Vaco by Highspring", "Senior Consultant", "staffing_agency"],
    ["Kelly Services", "Staffing Specialist", "staffing_agency"],
    ["City of West Palm Beach", "Code Enforcement Officer", "public_sector"],
    ["State of Florida", "Administrative Assistant II", "public_sector"],
    ["Palm Beach County School District", "Teacher", "school"],
    ["Florida Atlantic University", "Adjunct Professor", "school"],
    ["Broward Health System", "Patient Access Rep", "hospital_system"],
    ["Orlando Regional Medical Center", "Phlebotomist", "hospital_system"],
    ["Atlas Staffing Solutions", "Branch Manager", "third_party_posting"],
    ["Premier Talent Solutions", "Sourcing Specialist", "third_party_posting"],
  ];

  it("each carries its expected flag with a confidence entry", () => {
    for (const [name, title, expectedFlag] of badLeads) {
      const annotation = scoreLeadIcp(lead(name, title), allScoringOn());
      expect(
        annotation.exclusionFlags,
        `${name} should carry ${expectedFlag}`,
      ).toContain(expectedFlag);
      expect(validateAnnotationIntegrity(annotation)).toEqual([]);
    }
  });

  it("bad fits sink below good fits when scoring is enabled", () => {
    const scoringConfig = allScoringOn();
    const good = scoreLeadIcp(
      lead("Sunbelt Manufacturing Inc", "Plant Controller"),
      scoringConfig,
    );
    const bad = scoreLeadIcp(lead("Walmart", "Cashier"), scoringConfig);
    expect(good.icpAdjustedScore).toBeGreaterThan(bad.icpAdjustedScore);
  });
});

describe("shadow mode — flags all OFF changes nothing", () => {
  function allScoringOff(): IcpConfig {
    let c = config;
    for (const flag of ICP_FLAG_NAMES) c = withFlag(c, flag, false);
    return c;
  }

  it("with every flag off the adjusted score equals the base score", () => {
    const annotation = scoreLeadIcp(lead("Walmart", "Cashier"), allScoringOff());
    expect(annotation.icpAdjustedScore).toBe(60);
    // Flags are still annotated (observable), but nothing is scored down.
    expect(annotation.exclusionFlags).toContain("fortune_500");
  });

  it("no toggle enabled → nothing is hidden, ever", () => {
    const annotation = scoreLeadIcp(lead("Walmart", "Cashier"), config);
    expect(isHiddenByToggles(annotation, {})).toBe(false);
  });
});

describe("when-in-doubt-keep", () => {
  it("ambiguous titles resolve toward the higher-value bucket, never hourly", () => {
    const role = classifyRoleType("Associate Director of Operations", config);
    expect(["leadership", "management", "professional"]).toContain(role.roleType);
  });

  it("unknown titles stay unknown with neutral confidence and no penalty", () => {
    const annotation = scoreLeadIcp(
      lead("Quiet Company LLC", "Wizard of Miscellany"),
      allScoringOn(),
    );
    expect(annotation.roleType).toBe("unknown");
    expect(annotation.icpAdjustedScore).toBeGreaterThan(0);
  });
});

describe("compensation", () => {
  it("annualizes hourly rates × 2080", () => {
    const result = normalizeListingComp(
      { title: "Cleaner", salaryMin: 18, salaryMax: 20, salaryText: "$18–$20 an hour" },
      config,
    );
    expect(result.annualMin).toBe(18 * 2080);
    expect(result.annualMax).toBe(20 * 2080);
  });

  it("treats sub-1000 numeric ranges as hourly even without text", () => {
    const result = normalizeListingComp(
      { title: "Server", salaryMin: 15, salaryMax: 22 },
      config,
    );
    expect(result.annualMax).toBe(22 * 2080);
  });

  it("flags below-min from listing data but never from an estimate", () => {
    const belowMin = scoreLeadIcp(
      lead("Quick Serve LLC", "Crew Member", {
        listings: [{ title: "Crew Member", salaryMin: 12, salaryMax: 14 }],
      }),
      allScoringOn(),
    );
    expect(belowMin.exclusionFlags).toContain("salary_below_min");

    const estimated = scoreLeadIcp(lead("Coastal Law Group LLC", "Paralegal"), allScoringOn());
    expect(estimated.compEstimatedFlag).toBe(true);
    expect(estimated.exclusionFlags).not.toContain("salary_below_min");
  });

  it("an estimate adjusts the score by at most ±5", () => {
    const scoringConfig = allScoringOn();
    const withEstimate = scoreLeadIcp(
      lead("Coastal Law Group LLC", "Paralegal"),
      scoringConfig,
    );
    const withoutEstimate = scoreLeadIcp(
      lead("Coastal Law Group LLC", "Paralegal"),
      withFlag(scoringConfig, "comp_estimate_enabled", false),
    );
    expect(
      Math.abs(withEstimate.icpAdjustedScore - withoutEstimate.icpAdjustedScore),
    ).toBeLessThanOrEqual(config.score_weights.comp_estimate_adjustment_max);
  });
});

describe("integrity (§7.7) — flags and confidences always paired", () => {
  it("every produced annotation passes the integrity check", () => {
    const inputs: IcpLeadInput[] = [
      lead("Walmart", "Cashier"),
      lead("City of Austin", "Clerk"),
      lead("Robert Half", "Recruiter", { domain: "roberthalf.com" }),
      lead("Quiet Company LLC", "Controller"),
      lead("Austin Water", "Analyst", { domain: "austintexas.gov" }),
    ];
    for (const annotation of icpScorer(inputs, allScoringOn())) {
      expect(validateAnnotationIntegrity(annotation)).toEqual([]);
    }
  });

  it("detects orphan flags and orphan confidences", () => {
    expect(
      validateAnnotationIntegrity({
        exclusionFlags: ["fortune_500"],
        exclusionConfidence: {},
      }),
    ).toHaveLength(1);
    expect(
      validateAnnotationIntegrity({
        exclusionFlags: [],
        exclusionConfidence: { ghost: 1 },
      }),
    ).toHaveLength(1);
  });
});

describe("score structure — clamped, multiplier first", () => {
  it("stays within 0–100 at the extremes", () => {
    const scoringConfig = allScoringOn();
    const high = scoreLeadIcp(
      lead("Elite Manufacturing Inc", "VP of Operations", {
        baseLeadScore: 100,
        hiringSignals: { reposted_role: 8, multiple_openings: 3 },
      }),
      scoringConfig,
    );
    expect(high.icpAdjustedScore).toBeLessThanOrEqual(100);

    const low = scoreLeadIcp(
      lead("Walmart", "Cashier", { baseLeadScore: 5, estimatedEmployees: 2100000 }),
      scoringConfig,
    );
    expect(low.icpAdjustedScore).toBeGreaterThanOrEqual(0);
    expect(low.exclusionFlags).toContain("size_above_max");
  });
});
