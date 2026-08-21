import { describe, expect, it } from "vitest";
import {
  classifyMapsExclusion,
  dedupeMapsOrganizations,
  isNonCompanyHost,
  mapsDomain,
  mapsIndustry,
  marketStateAbbr,
  normalizeMapsPage,
  normalizeMapsResult,
  normalizeWebsiteHost,
  parseMapsAddress,
  type MapsLocalResult,
} from "@/lib/discovery/sources/serpapi-maps-normalize";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";

function result(overrides: Partial<MapsLocalResult> = {}): MapsLocalResult {
  return {
    title: "Palm Beach Roofing Co",
    address: "1200 Okeechobee Blvd, West Palm Beach, FL 33401, United States",
    phone: "+1 561-555-0142",
    website: "https://www.palmbeachroofing.com/",
    type: "Roofing contractor",
    types: ["Roofing contractor", "Gutter cleaning service"],
    ...overrides,
  };
}

describe("normalizeWebsiteHost", () => {
  it("strips scheme, www, path, query and fragment", () => {
    expect(normalizeWebsiteHost("https://www.example.com/pages/a?b=1#c")).toBe(
      "example.com",
    );
    expect(normalizeWebsiteHost("http://EXAMPLE.com")).toBe("example.com");
    expect(normalizeWebsiteHost("example.com/contact")).toBe("example.com");
  });

  /*
   * SerpApi's own documented Maps example returns a website with Google
   * Business Profile UTM parameters appended. Comparing that raw against a
   * stored bare domain would treat one company as two.
   */
  it("survives the utm_source=gbp query string Maps actually returns", () => {
    expect(
      normalizeWebsiteHost(
        "https://www.stumptowncoffee.com/pages/new-york-ace-hotel-cafe?utm_source=gbp&utm_medium=organic&utm_campaign=local",
      ),
    ).toBe("stumptowncoffee.com");
  });

  it("keeps meaningful subdomains but drops ports and trailing dots", () => {
    expect(normalizeWebsiteHost("https://law.example.com:8443/")).toBe(
      "law.example.com",
    );
    expect(normalizeWebsiteHost("example.com.")).toBe("example.com");
  });

  it("rejects anything that is not a host", () => {
    expect(normalizeWebsiteHost("")).toBeNull();
    expect(normalizeWebsiteHost("   ")).toBeNull();
    expect(normalizeWebsiteHost(null)).toBeNull();
    expect(normalizeWebsiteHost("localhost")).toBeNull();
    expect(normalizeWebsiteHost("not a domain")).toBeNull();
  });
});

/*
 * companies.domain is UNIQUE. If a Facebook page were accepted as a domain the
 * first Facebook-hosted company would claim facebook.com and every subsequent
 * one would silently merge into that single row. This is the highest-severity
 * failure mode in the whole source.
 */
describe("mapsDomain refuses hosts that are never a company's own", () => {
  it("rejects social, directory and site-builder hosts", () => {
    for (const host of [
      "https://facebook.com/pbroofing",
      "https://m.facebook.com/pbroofing",
      "https://instagram.com/currentcoffeeshop?igshid=YmMyMTA2M2Y=",
      "https://www.yelp.com/biz/some-firm",
      "https://linktr.ee/firm",
      "https://someone.business.site",
      "https://firm.wixsite.com/home",
      "https://www.avvo.com/attorneys/1234.html",
    ]) {
      expect(mapsDomain(host)).toBeNull();
    }
  });

  it("accepts a real company site", () => {
    expect(mapsDomain("https://www.palmbeachroofing.com/?utm_source=gbp")).toBe(
      "palmbeachroofing.com",
    );
  });

  it("matches on the registrable tail, not a substring", () => {
    expect(isNonCompanyHost("notfacebook.com")).toBe(false);
    expect(isNonCompanyHost("pages.facebook.com")).toBe(true);
  });
});

describe("parseMapsAddress", () => {
  it("reads city and state from the documented full form", () => {
    expect(
      parseMapsAddress("18 W 29th St, New York, NY 10001, United States"),
    ).toEqual({ city: "New York", state: "NY" });
  });

  it("handles a suite/unit street line and a missing country", () => {
    expect(
      parseMapsAddress("13200 Pond Springs Rd # D30, Austin, TX 78729"),
    ).toEqual({ city: "Austin", state: "TX" });
    expect(parseMapsAddress("555 Aleen St, Houston, TX 77029")).toEqual({
      city: "Houston",
      state: "TX",
    });
  });

  it("accepts a ZIP+4 and a spelled-out state", () => {
    expect(parseMapsAddress("1 Main St, Tampa, FL 33602-1234")).toEqual({
      city: "Tampa",
      state: "FL",
    });
    expect(parseMapsAddress("1 Main St, Tampa, Florida")).toEqual({
      city: "Tampa",
      state: "FL",
    });
  });

  /*
   * google_local returns street-only addresses. A missing state is missing
   * data, not evidence of geographic drift, so it must parse to null rather
   * than guess.
   */
  it("returns nulls for a street-only address", () => {
    expect(parseMapsAddress("51 Rainey St #130")).toEqual({
      city: null,
      state: null,
    });
    expect(parseMapsAddress("")).toEqual({ city: null, state: null });
    expect(parseMapsAddress(undefined)).toEqual({ city: null, state: null });
  });
});

describe("marketStateAbbr", () => {
  it("reads the state from the curated discovery markets", () => {
    expect(marketStateAbbr("Palm Beach County, Florida")).toBe("FL");
    expect(marketStateAbbr("Dallas, Texas")).toBe("TX");
    expect(marketStateAbbr("Charlotte, North Carolina")).toBe("NC");
  });

  it("returns null when the market names no recognisable state", () => {
    expect(marketStateAbbr("")).toBeNull();
    expect(marketStateAbbr("Somewhere Nice")).toBeNull();
  });
});

/*
 * The free qualification layer: every rejection below happens before a company
 * is written, and therefore before any Apollo or ContactOut credit could exist.
 */
describe("classifyMapsExclusion enforces the operator's exclusion list", () => {
  it("keeps a small local contractor", () => {
    expect(classifyMapsExclusion(result())).toBeNull();
  });

  it("rejects recruiters by Google's own business category", () => {
    // Better data than a name regex: an agency named after its founder has no
    // "staffing" in the name, but it still self-labels the category.
    expect(
      classifyMapsExclusion(
        result({
          title: "Whitfield & Doyle",
          type: "Employment agency",
          types: ["Employment agency"],
        }),
      ),
    ).toBe("staffing_agency");
    expect(
      classifyMapsExclusion(
        result({ title: "Coastal Partners", type: "Executive search firm" }),
      ),
    ).toBe("staffing_agency");
  });

  it("rejects recruiters by the shared icp-config name patterns", () => {
    expect(
      classifyMapsExclusion(
        result({ title: "Gulfstream Staffing Solutions", type: "Consultant" }),
      ),
    ).toBe("staffing_agency");
    expect(
      classifyMapsExclusion(
        result({ title: "Atlantic Recruiting Group", type: "Consultant" }),
      ),
    ).toBe("staffing_agency");
  });

  it("rejects known national staffing agencies by name", () => {
    expect(
      classifyMapsExclusion(result({ title: "Robert Half", type: "Consultant" })),
    ).toBe("staffing_agency");
  });

  it("rejects government by category, name pattern and .gov domain", () => {
    expect(
      classifyMapsExclusion(
        result({ title: "Riviera Beach Annex", type: "City government office" }),
      ),
    ).toBe("public_sector");
    expect(
      classifyMapsExclusion(
        result({ title: "City of West Palm Beach", type: "Consultant" }),
      ),
    ).toBe("public_sector");
    expect(
      classifyMapsExclusion(
        result({
          title: "Coastal Services Bureau",
          type: "Consultant",
          website: "https://www.pbcgov.gov/services",
        }),
      ),
    ).toBe("public_sector");
  });

  it("rejects schools and hospital systems", () => {
    expect(
      classifyMapsExclusion(result({ title: "Suncoast High School", type: "High school" })),
    ).toBe("school");
    expect(
      classifyMapsExclusion(result({ title: "Jupiter Medical Center", type: "Hospital" })),
    ).toBe("hospital_system");
  });

  it("rejects the Fortune and national-retailer known lists", () => {
    expect(
      classifyMapsExclusion(result({ title: "Walmart", type: "Department store" })),
    ).toBe("known_large");
    expect(
      classifyMapsExclusion(result({ title: "Deloitte", type: "Consultant" })),
    ).toBe("known_large");
  });

  it("rejects categories that are not an employer at all", () => {
    expect(classifyMapsExclusion(result({ title: "USPS Drop Box", type: "Post office" }))).toBe(
      "not_an_employer",
    );
    expect(classifyMapsExclusion(result({ title: "Regus", type: "Coworking space" }))).toBe(
      "not_an_employer",
    );
  });

  it("rejects a nameless result", () => {
    expect(classifyMapsExclusion(result({ title: "" }))).toBe("no_name");
    expect(classifyMapsExclusion(result({ title: undefined }))).toBe("no_name");
  });
});

describe("normalizeMapsResult", () => {
  it("maps the documented fields onto DiscoveredOrganization", () => {
    const normalized = normalizeMapsResult(result(), { marketState: "FL" });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.organization).toMatchObject({
      name: "Palm Beach Roofing Co",
      domain: "palmbeachroofing.com",
      industry: "Roofing contractor",
      phone: "+1 561-555-0142",
      city: "West Palm Beach",
      state: "FL",
      domainConfidence: "high",
    });
  });

  /*
   * Maps has no headcount field at all. Inventing one would defeat the
   * vertical employee bands; leaving it null routes the company into the
   * unknown-size pool the pipeline already reserves a share of the batch for.
   */
  it("never invents a headcount, and never a LinkedIn URL", () => {
    const normalized = normalizeMapsResult(result(), { marketState: "FL" });
    if (!normalized.ok) throw new Error("expected ok");
    expect(normalized.organization.estimatedEmployees).toBeNull();
    expect(normalized.organization.linkedinUrl).toBeNull();
    expect(normalized.organization.foundedYear).toBeNull();
  });

  it("keeps a company whose website is a Facebook page, with no domain", () => {
    const normalized = normalizeMapsResult(
      result({ website: "https://facebook.com/pbroofing" }),
      { marketState: "FL" },
    );
    if (!normalized.ok) throw new Error("expected ok");
    expect(normalized.organization.domain).toBeNull();
    expect(normalized.organization.domainConfidence).toBe("low");
    // The raw URL is still worth keeping for the operator to eyeball.
    expect(normalized.organization.websiteUrl).toBe(
      "https://facebook.com/pbroofing",
    );
  });

  it("drops a result whose state contradicts the requested market", () => {
    const normalized = normalizeMapsResult(
      result({ address: "1 Main St, Valdosta, GA 31601" }),
      { marketState: "FL" },
    );
    expect(normalized).toEqual({ ok: false, reason: "out_of_market" });
  });

  it("keeps a result whose address has no state — missing is not drift", () => {
    const normalized = normalizeMapsResult(
      result({ address: "51 Rainey St #130" }),
      { marketState: "FL" },
    );
    expect(normalized.ok).toBe(true);
  });

  it("drops a short-code phone rather than storing an undialable number", () => {
    const normalized = normalizeMapsResult(result({ phone: "16224" }), {
      marketState: "FL",
    });
    if (!normalized.ok) throw new Error("expected ok");
    expect(normalized.organization.phone).toBeNull();
  });

  it("falls back to the first of types when type is absent", () => {
    expect(mapsIndustry({ types: ["HVAC contractor"] })).toBe("HVAC contractor");
    expect(mapsIndustry({})).toBeNull();
  });
});

function org(overrides: Partial<DiscoveredOrganization> = {}): DiscoveredOrganization {
  return {
    name: "Acme Roofing",
    domain: "acmeroofing.com",
    websiteUrl: "https://acmeroofing.com",
    industry: "Roofing contractor",
    estimatedEmployees: null,
    phone: null,
    linkedinUrl: null,
    foundedYear: null,
    city: "West Palm Beach",
    state: "FL",
    domainConfidence: "high",
    ...overrides,
  };
}

describe("dedupeMapsOrganizations", () => {
  it("collapses the same domain across pages of one sweep", () => {
    const seen = new Set<string>();
    const first = dedupeMapsOrganizations([org()], seen);
    const second = dedupeMapsOrganizations(
      [org({ name: "Acme Roofing LLC" })],
      seen,
    );
    expect(first.organizations).toHaveLength(1);
    expect(second.organizations).toHaveLength(0);
    expect(second.duplicates).toBe(1);
  });

  /*
   * Google returns an unclaimed profile beside the claimed one. Without a
   * domain the only key is the name, which must still collapse them — matching
   * how run.ts dedupes against the database.
   */
  it("collapses domain-less duplicates on the normalised name", () => {
    const { organizations, duplicates } = dedupeMapsOrganizations([
      org({ domain: null, name: "Acme Roofing Inc" }),
      org({ domain: null, name: "Acme Roofing, Inc." }),
    ]);
    expect(organizations).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  /*
   * Franchises: the same trade name in two states is two businesses with two
   * hiring authorities, so the name key is scoped by state.
   */
  it("keeps the same name in two states apart", () => {
    const { organizations } = dedupeMapsOrganizations([
      org({ domain: null, state: "FL" }),
      org({ domain: null, state: "TX" }),
    ]);
    expect(organizations).toHaveLength(2);
  });

  /*
   * ...but a shared corporate domain still collapses franchise locations. This
   * is a deliberate, documented tradeoff, not an oversight: one domain usually
   * means one hiring authority.
   */
  it("collapses franchise locations that share a corporate domain", () => {
    const { organizations, duplicates } = dedupeMapsOrganizations([
      org({ name: "Roto-Rooter — West Palm Beach", state: "FL" }),
      org({ name: "Roto-Rooter — Boca Raton", state: "FL" }),
    ]);
    expect(organizations).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe("normalizeMapsPage", () => {
  it("tallies rejections by reason for the run summary", () => {
    const page = normalizeMapsPage(
      [
        result(),
        result({ title: "Gulfstream Staffing Solutions" }),
        result({ title: "Coastal Search Partners" }),
        result({ title: "City of Lake Worth" }),
        result({ address: "1 Main St, Valdosta, GA 31601", title: "Georgia Roofing", website: null as unknown as string }),
      ],
      { marketState: "FL" },
    );

    expect(page.organizations).toHaveLength(1);
    expect(page.rejected).toEqual({
      staffing_agency: 2,
      public_sector: 1,
      out_of_market: 1,
    });
  });

  it("counts in-batch duplicates separately from exclusions", () => {
    const page = normalizeMapsPage([result(), result()], { marketState: "FL" });
    expect(page.organizations).toHaveLength(1);
    expect(page.rejected.duplicate_in_batch).toBe(1);
  });
});
