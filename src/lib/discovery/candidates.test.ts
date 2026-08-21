import { describe, expect, it } from "vitest";
import {
  candidateKey,
  selectDiscoveryCandidates,
} from "@/lib/discovery/candidates";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";

function org(
  name: string,
  overrides: Partial<DiscoveredOrganization> = {},
): DiscoveredOrganization {
  return {
    name,
    domain: `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
    websiteUrl: null,
    industry: "law practice",
    estimatedEmployees: 40,
    phone: null,
    linkedinUrl: null,
    foundedYear: null,
    city: "Miami",
    state: "Florida",
    domainConfidence: "high",
    annualRevenue: null,
    publiclyTradedSymbol: null,
    ...overrides,
  };
}

describe("candidateKey", () => {
  it("keys on domain when Apollo has one", () => {
    expect(candidateKey({ domain: "Vega-Law.com", name: "Vega Law" })).toBe(
      "domain:vega-law.com",
    );
  });

  it("falls back to the normalised name (Postgres nulls do not collide)", () => {
    expect(candidateKey({ domain: null, name: "Vega Law Group, LLC" })).toBe(
      candidateKey({ domain: null, name: "Vega Law" }),
    );
  });
});

describe("selectDiscoveryCandidates", () => {
  it("dedupes Apollo rows that describe the same company", () => {
    const result = selectDiscoveryCandidates({
      vertical: "legal",
      sized: [
        org("Vega Law"),
        org("Vega Law"),
        // Same firm, no domain on this row — must still collide on the name.
        org("Vega Law Group LLC", { domain: null }),
        org("Rosen Firm"),
      ],
      unknownSize: [],
      limit: 25,
    });

    expect(result.candidates.map((c) => c.name)).toEqual([
      "Vega Law",
      "Rosen Firm",
    ]);
    expect(result.duplicatesSkipped).toBe(2);
  });

  it("never re-surfaces a company from a previous run", () => {
    const result = selectDiscoveryCandidates({
      vertical: "legal",
      sized: [org("Vega Law"), org("Rosen Firm")],
      unknownSize: [],
      limit: 25,
      excludeKeys: new Set(["domain:vegalaw.com"]),
    });
    expect(result.candidates.map((c) => c.name)).toEqual(["Rosen Firm"]);
    expect(result.duplicatesSkipped).toBe(1);
  });

  it("surfaces unknown-headcount companies instead of letting the filter hide them", () => {
    const result = selectDiscoveryCandidates({
      vertical: "legal",
      sized: [org("A Firm"), org("B Firm")],
      unknownSize: [
        org("No Headcount Firm", { estimatedEmployees: null }),
        // Known headcount in the unknown pass belongs to the sized pool.
        org("Counted Firm", { estimatedEmployees: 44 }),
      ],
      limit: 4,
    });

    const names = result.candidates.map((c) => c.name);
    expect(names).toContain("No Headcount Firm");
    expect(names).not.toContain("Counted Firm");
    expect(result.sizeUnknownCount).toBe(1);
    expect(
      result.candidates.find((c) => c.name === "No Headcount Firm")?.sizeUnknown,
    ).toBe(true);
  });

  it("reserves room for unknown-headcount firms in a full batch", () => {
    const sized = Array.from({ length: 40 }, (_, i) => org(`Sized ${i}`));
    const unknownSize = Array.from({ length: 10 }, (_, i) =>
      org(`Unknown ${i}`, { estimatedEmployees: null }),
    );
    const result = selectDiscoveryCandidates({
      vertical: "legal",
      sized,
      unknownSize,
      limit: 25,
    });
    expect(result.candidates).toHaveLength(25);
    expect(result.sizeUnknownCount).toBe(5);
  });

  it("backfills with sized results when the unknown pass is thin", () => {
    const sized = Array.from({ length: 40 }, (_, i) => org(`Sized ${i}`));
    const result = selectDiscoveryCandidates({
      vertical: "legal",
      sized,
      unknownSize: [],
      limit: 25,
    });
    expect(result.candidates).toHaveLength(25);
    expect(result.sizeUnknownCount).toBe(0);
  });

  it("flags out-of-band headcount without dropping the company", () => {
    const result = selectDiscoveryCandidates({
      vertical: "legal",
      sized: [org("Huge Firm", { estimatedEmployees: 5000 })],
      unknownSize: [],
      limit: 25,
    });
    expect(result.candidates[0].sizeOutOfBand).toBe(true);
  });
});
