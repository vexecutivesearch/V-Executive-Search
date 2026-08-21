import { describe, expect, it } from "vitest";
import {
  activeReviewFilters,
  CITY_OPTION_LIMIT,
  cityOptionsForState,
  defaultDiscoveryMarket,
  normalizeLocationScope,
  normalizeReviewScope,
  reviewQueueQueryFilters,
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

  it("never lets a city outlive the state that scoped it", () => {
    // The server-side city predicate matches on name alone, so "Springfield"
    // without its own state would match FL and TN at once. Whichever state is
    // selected, the persisted pair is either consistent or has no city at all.
    for (const state of ["", "FL", "GA", "TN", "ZZ"]) {
      const scope = normalizeLocationScope({ state, city: "Springfield" }, OPTIONS);
      if (!scope.city) continue;
      expect(
        OPTIONS.cities.some(
          (c) => c.city === scope.city && c.stateAbbr === scope.state,
        ),
      ).toBe(true);
    }
    expect(normalizeLocationScope({ state: "GA", city: "Springfield" }, OPTIONS))
      .toEqual({ state: "GA", city: "" });
  });
});

describe("normalizeReviewScope", () => {
  const FACETS = {
    verticals: ["hvac", "restoration"],
    markets: ["Palm Beach County, Florida", "Atlanta, Georgia"],
  };

  it("keeps a vertical and market that still have chips", () => {
    expect(
      normalizeReviewScope(
        { vertical: "hvac", dmarket: "Atlanta, Georgia", q: " acme " },
        FACETS,
      ),
    ).toEqual({
      vertical: "hvac",
      market: "Atlanta, Georgia",
      search: "acme",
    });
  });

  it("drops a vertical or market with no chip left to clear it", () => {
    // A bookmarked URL from before a bucket was emptied would otherwise hide
    // the whole queue with nothing on screen to blame.
    expect(
      normalizeReviewScope(
        { vertical: "retired_vertical", dmarket: "Boise, Idaho" },
        FACETS,
      ),
    ).toEqual({ vertical: "", market: "", search: "" });
  });

  it("ignores browse location entirely", () => {
    const scope = normalizeReviewScope(
      { vertical: "hvac" } as Record<string, string>,
      FACETS,
    );
    expect(Object.keys(scope).sort()).toEqual(["market", "search", "vertical"]);
  });
});

describe("reviewQueueQueryFilters", () => {
  it("carries no state or city, so counts read the same fields as the list", () => {
    const filters = reviewQueueQueryFilters(
      { vertical: "hvac", market: "Palm Beach County, Florida", search: "" },
      { reviewStatus: "pending", page: 2 },
    );
    expect(filters).toEqual({
      reviewStatus: "pending",
      vertical: "hvac",
      market: "Palm Beach County, Florida",
      search: undefined,
      page: 2,
    });
    expect(Object.keys(filters)).not.toContain("state");
    expect(Object.keys(filters)).not.toContain("city");
  });
});

describe("activeReviewFilters", () => {
  it("names each filter by the query key that clears it", () => {
    expect(
      activeReviewFilters({
        vertical: "hvac",
        market: "Atlanta, Georgia",
        search: "acme",
      }),
    ).toEqual([
      { key: "vertical", value: "hvac" },
      { key: "dmarket", value: "Atlanta, Georgia" },
      { key: "q", value: "acme" },
    ]);
  });

  it("reports nothing when the queue is unfiltered", () => {
    expect(
      activeReviewFilters({ vertical: "", market: "", search: "" }),
    ).toEqual([]);
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
