import { describe, expect, it } from "vitest";
import {
  CITY_OPTION_LIMIT,
  cityOptionsForState,
  defaultDiscoveryMarket,
  normalizeLocationScope,
  stateLabel,
  type CityOption,
} from "@/lib/crm-location-scope";

const OPTIONS = {
  states: ["FL", "GA", "NC", "TN"],
  cities: [
    { city: "Adairsville", stateAbbr: "GA" },
    { city: "Atlanta", stateAbbr: "GA" },
    { city: "Charlotte", stateAbbr: "NC" },
    { city: "Miami", stateAbbr: "FL" },
    { city: "Nashville", stateAbbr: "TN" },
    { city: "Springfield", stateAbbr: "FL" },
    { city: "Springfield", stateAbbr: "TN" },
  ] satisfies CityOption[],
};

/** The curated Apollo search targets from config/contact-targets.json. */
const MARKETS = [
  "Palm Beach County, Florida",
  "Miami, Florida",
  "Fort Lauderdale, Florida",
  "Tampa, Florida",
  "Orlando, Florida",
  "Jacksonville, Florida",
  "Dallas, Texas",
  "Houston, Texas",
  "Atlanta, Georgia",
  "Charlotte, North Carolina",
  "Nashville, Tennessee",
];

describe("normalizeLocationScope", () => {
  it("keeps a city that belongs to the selected state", () => {
    expect(normalizeLocationScope({ state: "FL", city: "Miami" }, OPTIONS)).toEqual(
      { state: "FL", city: "Miami" },
    );
  });

  it("drops a city selected with no state scope", () => {
    // The operator's screenshot: "Adairsville, GA" next to "All states".
    expect(
      normalizeLocationScope({ state: undefined, city: "Adairsville" }, OPTIONS),
    ).toEqual({ state: "", city: "" });
  });

  it("drops a city left over from a different state", () => {
    expect(
      normalizeLocationScope({ state: "FL", city: "Adairsville" }, OPTIONS),
    ).toEqual({ state: "FL", city: "" });
  });

  it("keeps a same-named city when it exists in the selected state", () => {
    expect(
      normalizeLocationScope({ state: "TN", city: "Springfield" }, OPTIONS),
    ).toEqual({ state: "TN", city: "Springfield" });
  });

  it("canonicalizes casing so the rail highlight matches the dropdown", () => {
    expect(normalizeLocationScope({ state: "fl", city: "miami" }, OPTIONS)).toEqual(
      { state: "FL", city: "Miami" },
    );
  });

  it("drops an unknown state along with its city", () => {
    expect(normalizeLocationScope({ state: "ZZ", city: "Miami" }, OPTIONS)).toEqual(
      { state: "", city: "" },
    );
  });

  it("ignores surrounding whitespace", () => {
    expect(
      normalizeLocationScope({ state: " FL ", city: " Miami " }, OPTIONS),
    ).toEqual({ state: "FL", city: "Miami" });
  });

  it("is idempotent", () => {
    const once = normalizeLocationScope({ state: "ga", city: "ATLANTA" }, OPTIONS);
    expect(normalizeLocationScope(once, OPTIONS)).toEqual(once);
  });
});

describe("cityOptionsForState", () => {
  it("offers nothing until a state is chosen", () => {
    expect(cityOptionsForState(OPTIONS.cities, "")).toEqual([]);
  });

  it("offers only cities in the chosen state", () => {
    expect(cityOptionsForState(OPTIONS.cities, "GA")).toEqual([
      { city: "Adairsville", stateAbbr: "GA" },
      { city: "Atlanta", stateAbbr: "GA" },
    ]);
  });

  it("caps the rendered list", () => {
    const many = Array.from({ length: CITY_OPTION_LIMIT + 25 }, (_, i) => ({
      city: `City ${i}`,
      stateAbbr: "FL",
    }));
    expect(cityOptionsForState(many, "FL")).toHaveLength(CITY_OPTION_LIMIT);
  });
});

describe("defaultDiscoveryMarket", () => {
  it("prefers a market that matches both city and state", () => {
    expect(defaultDiscoveryMarket(MARKETS, { state: "FL", city: "Miami" })).toBe(
      "Miami, Florida",
    );
  });

  it("falls back to the first market in the browsed state", () => {
    expect(defaultDiscoveryMarket(MARKETS, { state: "FL" })).toBe(
      "Palm Beach County, Florida",
    );
  });

  it("falls back to the state when the browsed city is not a search target", () => {
    // Adairsville is real browse data but a poor Apollo location query.
    expect(defaultDiscoveryMarket(MARKETS, { state: "GA", city: "Adairsville" })).toBe(
      "Atlanta, Georgia",
    );
  });

  it("suggests nothing when the browse scope is all locations", () => {
    expect(defaultDiscoveryMarket(MARKETS, {})).toBeNull();
  });

  it("suggests nothing for a state with no curated market", () => {
    expect(defaultDiscoveryMarket(MARKETS, { state: "AL" })).toBeNull();
  });
});

describe("stateLabel", () => {
  it("expands an abbreviation to the rail's wording", () => {
    expect(stateLabel("FL")).toBe("Florida");
  });

  it("passes through anything it cannot expand", () => {
    expect(stateLabel("")).toBe("");
  });
});
