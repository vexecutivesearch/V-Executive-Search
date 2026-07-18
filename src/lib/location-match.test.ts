import { describe, expect, it } from "vitest";
import { parseJobLocation } from "@/lib/location-match";

describe("parseJobLocation", () => {
  it("parses city, state abbreviations", () => {
    expect(parseJobLocation("Denver, CO")).toMatchObject({
      city: "Denver",
      stateAbbr: "CO",
      stateName: "Colorado",
    });
  });

  it("strips a trailing US country token from city/state locations", () => {
    expect(parseJobLocation("Denver, CO, United States")).toMatchObject({
      city: "Denver",
      stateAbbr: "CO",
    });
    expect(parseJobLocation("Austin, TX, US")).toMatchObject({
      city: "Austin",
      stateAbbr: "TX",
    });
  });

  it("returns null for country-only locations instead of throwing", () => {
    // Live Neon data includes bare "United States" rows from LinkedIn.
    // After stripping the country token, parts is empty — must not crash.
    expect(parseJobLocation("United States")).toBeNull();
    expect(parseJobLocation("US")).toBeNull();
    expect(parseJobLocation("USA")).toBeNull();
  });

  it("returns null for remote / empty locations", () => {
    expect(parseJobLocation("Remote")).toBeNull();
    expect(parseJobLocation("")).toBeNull();
    expect(parseJobLocation("   ")).toBeNull();
  });
});
