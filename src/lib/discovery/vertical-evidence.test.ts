import { describe, expect, it } from "vitest";
import {
  verticalBadgeLabel,
  verticalEvidence,
} from "@/lib/discovery/vertical-evidence";
import { keywordTagsForVertical, verticalIds } from "@/lib/discovery/verticals";
import { scoreCompanyFirst } from "@/lib/lead-score";

/**
 * Discovery stamps `companies.vertical` from the run parameter and has to — the
 * ICP employee band, the company-first score and the decision-maker title
 * priority all read it. But the run parameter is not evidence about the
 * company, so the review queue must not present it as one.
 *
 * The three rows the operator caught are the cases below: a beauty brand in a
 * Construction run, a marketing agency in a Legal run, and a company whose only
 * industry value is the job-scrape worker's coarse rollup.
 */
describe("vertical evidence is honest about what Apollo actually returned", () => {
  it("confirms a law firm found by the Legal search", () => {
    const evidence = verticalEvidence({
      vertical: "legal",
      name: "Vega Law Offices, PLLC",
      industry: "law practice",
    });
    expect(evidence.status).toBe("confirmed");
    expect(evidence.matchedOn).toBe("law practice");
  });

  it("confirms from the company name when Apollo has no industry", () => {
    const evidence = verticalEvidence({
      vertical: "construction",
      name: "Coastal Roofing & Sheet Metal",
      industry: null,
    });
    expect(evidence.status).toBe("confirmed");
    expect(evidence.matchedOn).toBe("roofing");
  });

  /* THAT Agency — a marketing agency the Legal search returned. */
  it("flags a marketing agency tagged Legal as a mismatch", () => {
    const evidence = verticalEvidence({
      vertical: "legal",
      name: "THAT Agency",
      industry: "marketing & advertising",
    });
    expect(evidence.status).toBe("contradicted");
    expect(evidence.looksLike).toBe("General Professional Services");
    expect(evidence.reason).toContain("marketing & advertising");
  });

  it("flags the mismatch from the name alone when the industry is missing", () => {
    const evidence = verticalEvidence({
      vertical: "legal",
      name: "THAT Agency",
      industry: null,
    });
    expect(evidence.status).toBe("contradicted");
    expect(evidence.matchedOn).toBe("agency");
  });

  /* Keratin Complex — a hair-care brand the Construction search returned. */
  it("flags a beauty brand tagged Construction as a mismatch", () => {
    const evidence = verticalEvidence({
      vertical: "construction",
      name: "Keratin Complex",
      industry: "cosmetics",
    });
    expect(evidence.status).toBe("contradicted");
  });

  /*
   * Ray Thomas — nothing in the name says "law", and the only industry on file
   * is the coarse rollup the job-scrape worker writes when Apollo gave it
   * nothing. That is not evidence in either direction, so the honest answer is
   * "found via the Legal search", not "this is a law firm".
   */
  it("stays unverified when the only industry is a pipeline rollup label", () => {
    const evidence = verticalEvidence({
      vertical: "legal",
      name: "Ray Thomas",
      industry: "Professional & Business Services",
    });
    expect(evidence.status).toBe("unverified");
    expect(evidence.reason).toContain("Found via the Legal search");
    expect(evidence.reason).toContain("rollup label");
  });

  it("does not let a rollup label confirm a vertical either", () => {
    // "Construction & Real Estate" is a rollup bucket, not an Apollo industry.
    const evidence = verticalEvidence({
      vertical: "construction",
      name: "Palmetto Holdings",
      industry: "Construction & Real Estate",
    });
    expect(evidence.status).toBe("unverified");
  });

  it("matches name patterns on whole words only", () => {
    // "law" must not fire on "Lawson", and "spa" must not fire on "Spacely".
    expect(
      verticalEvidence({
        vertical: "legal",
        name: "Lawson Manufacturing",
        industry: null,
      }).status,
    ).toBe("unverified");
    expect(
      verticalEvidence({
        vertical: "construction",
        name: "Spacely Builders",
        industry: null,
      }).matchedOn,
    ).toBe("builders");
  });

  it("says so plainly when there is no vertical at all", () => {
    const evidence = verticalEvidence({
      vertical: null,
      name: "Scraped Co",
      industry: "law practice",
    });
    expect(evidence.status).toBe("unverified");
    expect(evidence.looksLike).toBeNull();
  });
});

describe("the badge asserts the vertical only when the data supports it", () => {
  it("names the vertical when confirmed", () => {
    expect(verticalBadgeLabel("Legal", "confirmed")).toBe("Legal");
  });

  it("says how the company was FOUND when unverified", () => {
    expect(verticalBadgeLabel("Construction & Trades", "unverified")).toBe(
      "via Construction & Trades search",
    );
  });

  it("warns when the company's own data disagrees", () => {
    expect(verticalBadgeLabel("Legal", "contradicted")).toBe(
      "Legal search — mismatch",
    );
  });

  it("shows nothing for a company with no vertical", () => {
    expect(verticalBadgeLabel(null, "unverified")).toBeNull();
  });
});

describe("an off-target company does not outrank a genuine one", () => {
  const shared = {
    icpStatus: "pass" as const,
    estimatedEmployees: 40,
    domainConfidence: "high",
    hasPhone: true,
    hasLinkedIn: true,
    hiringSignals: {},
    openPositions: 0,
  };

  it("sinks a contradicted vertical below a confirmed one", () => {
    const genuine = scoreCompanyFirst({
      ...shared,
      vertical: "legal",
      verticalEvidence: "confirmed",
    });
    const offTarget = scoreCompanyFirst({
      ...shared,
      vertical: "legal",
      verticalEvidence: "contradicted",
    });
    expect(offTarget).toBeLessThan(genuine - 20);
  });

  it("does not punish a company merely for being unverified", () => {
    expect(
      scoreCompanyFirst({ ...shared, vertical: "legal", verticalEvidence: "unverified" }),
    ).toBe(
      scoreCompanyFirst({ ...shared, vertical: "legal", verticalEvidence: "confirmed" }),
    );
  });
});

describe("Apollo keyword tags avoid the terms that pulled off-target companies", () => {
  it("spells out the construction trade instead of bare 'restoration'", () => {
    const tags = keywordTagsForVertical("construction");
    expect(tags).not.toContain("restoration");
    expect(tags).toContain("water damage restoration");
  });

  it("drops the finance tags that match any consultancy", () => {
    const tags = keywordTagsForVertical("finance_accounting");
    expect(tags).not.toContain("advisory");
    expect(tags).not.toContain("tax");
  });

  it("keeps every vertical searchable", () => {
    for (const vertical of verticalIds()) {
      expect(keywordTagsForVertical(vertical).length).toBeGreaterThan(0);
    }
  });
});
