import { describe, expect, it } from "vitest";
import { companyHasListingInState } from "@/lib/crm-queries";

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
