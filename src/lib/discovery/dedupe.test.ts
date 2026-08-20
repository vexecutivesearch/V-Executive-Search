import { describe, expect, it } from "vitest";
import { normalizeCompanyKey } from "@/lib/company-name";
import { matchExistingCompany } from "@/lib/discovery/run";

type Row = Parameters<typeof matchExistingCompany>[1] extends {
  byDomain: Map<string, infer R>;
}
  ? R
  : never;

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

describe("discovery dedupe against existing companies", () => {
  it("matches a company already present from the job scrape by domain", () => {
    const index = indexOf([row("Vega Law PLLC", "vegalaw.com")]);
    expect(
      matchExistingCompany({ name: "Vega Law", domain: "VegaLaw.com" }, index)?.id,
    ).toBe("id-Vega Law PLLC");
  });

  it("matches on normalised name when the existing row has no domain", () => {
    const index = indexOf([row("Vega Law Group, LLC", null)]);
    expect(
      matchExistingCompany({ name: "Vega Law", domain: null }, index)?.id,
    ).toBe("id-Vega Law Group, LLC");
  });

  it("prefers the domain match over a name collision", () => {
    const index = indexOf([
      row("Vega Law of Miami", "vegalaw.com"),
      row("Vega Law", null),
    ]);
    expect(
      matchExistingCompany({ name: "Vega Law", domain: "vegalaw.com" }, index)?.id,
    ).toBe("id-Vega Law of Miami");
  });

  it("matches by name even when discovery brought a new domain", () => {
    // The scrape created the row with no domain; Apollo now has one. Matching
    // by name means the domain is filled in rather than a duplicate inserted.
    const index = indexOf([row("Rosen & Associates", null)]);
    expect(
      matchExistingCompany(
        { name: "Rosen and Associates", domain: "rosenlaw.com" },
        index,
      )?.id,
    ).toBe(undefined);
    expect(
      matchExistingCompany(
        { name: "Rosen & Associates", domain: "rosenlaw.com" },
        index,
      )?.id,
    ).toBe("id-Rosen & Associates");
  });

  it("returns null for a genuinely new company", () => {
    const index = indexOf([row("Vega Law PLLC", "vegalaw.com")]);
    expect(
      matchExistingCompany({ name: "Coastal Roofing", domain: "coastalroof.com" }, index),
    ).toBeNull();
  });
});
