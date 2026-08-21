import { describe, expect, it } from "vitest";
import {
  companyHasListingInState,
  companyMatchesCityScope,
  companyMatchesStateScope,
} from "@/lib/crm-queries";

describe("companyHasListingInState (Pipeline State filter)", () => {
  it("matches when a job listing is in the requested state", () => {
    expect(
      companyHasListingInState(
        [{ location: "Nashville, TN" }, { location: "Miami, FL" }],
        "TN",
      ),
    ).toBe(true);
  });

  it("does not match Florida-only listings for Tennessee", () => {
    expect(
      companyHasListingInState(
        [{ location: "Sunrise, FL" }, { location: "Boca Raton, FL" }],
        "TN",
      ),
    ).toBe(false);
  });

  it("ignores provenance-style labels that are not listing locations", () => {
    // source_market / marketLabel used to fake a TN match — listings win.
    expect(
      companyHasListingInState([{ location: "Palm Beach Gardens, FL" }], "TN"),
    ).toBe(false);
  });

  it("returns false when there are no listings", () => {
    expect(companyHasListingInState([], "TN")).toBe(false);
  });

  it("parses full state names in listing locations", () => {
    expect(
      companyHasListingInState([{ location: "Knoxville, Tennessee" }], "TN"),
    ).toBe(true);
  });
});

describe("companyMatchesStateScope (zero-listing companies)", () => {
  it("falls back to HQ for a company-first row with no listings", () => {
    // Apollo organization search creates these; with no listing to speak for
    // them they would otherwise be invisible under every state filter.
    expect(
      companyMatchesStateScope(
        { jobListings: [], city: "West Palm Beach", state: "Florida" },
        "FL",
      ),
    ).toBe(true);
  });

  it("does not put a zero-listing Florida company in Alabama", () => {
    expect(
      companyMatchesStateScope(
        { jobListings: [], city: "West Palm Beach", state: "Florida" },
        "AL",
      ),
    ).toBe(false);
  });

  it("reads a two-letter HQ state as well as a full name", () => {
    expect(
      companyMatchesStateScope({ jobListings: [], state: "FL" }, "FL"),
    ).toBe(true);
  });

  it("ignores HQ once the company has listings", () => {
    // Job-location-led browsing: a Nashville HQ posting only in Miami is a
    // Florida company here, and is not pulled into Tennessee by its HQ.
    const company = {
      jobListings: [{ location: "Miami, FL" }],
      city: "Nashville",
      state: "Tennessee",
    };
    expect(companyMatchesStateScope(company, "FL")).toBe(true);
    expect(companyMatchesStateScope(company, "TN")).toBe(false);
  });

  it("matches nothing when a zero-listing company has no HQ either", () => {
    expect(companyMatchesStateScope({ jobListings: [] }, "FL")).toBe(false);
  });
});

describe("companyMatchesCityScope (zero-listing companies)", () => {
  it("falls back to the HQ city with no listings", () => {
    expect(
      companyMatchesCityScope(
        { jobListings: [], city: "West Palm Beach" },
        "west palm beach",
      ),
    ).toBe(true);
  });

  it("ignores the HQ city once the company has listings", () => {
    expect(
      companyMatchesCityScope(
        { jobListings: [{ location: "Miami, FL" }], city: "Nashville" },
        "Nashville",
      ),
    ).toBe(false);
  });
});
