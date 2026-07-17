import { describe, expect, it } from "vitest";
import {
  activeMarketLabel,
  buildMarketIndex,
  deriveMarketFromListings,
  marketForJobLocation,
} from "@/lib/market-attribution";
import { DEFAULT_STATE_GEO_CONFIGS } from "@/lib/state-geo-config";
import {
  REVIEWABLE_STATE_GEO_EXPANSION,
  toStateGeoConfig,
} from "@/lib/state-geo-expanded-seed";
import type { GeoFocusSettings } from "@/lib/geo-focus";

const ALL_CONFIGS = [
  ...DEFAULT_STATE_GEO_CONFIGS,
  ...REVIEWABLE_STATE_GEO_EXPANSION.map((seed) => toStateGeoConfig(seed)),
];

const index = buildMarketIndex(ALL_CONFIGS);

describe("market attribution", () => {
  it("maps cross-state metro cities to their market, not their state", () => {
    // Rock Hill, SC is a Charlotte-market scrape hub — the exact case that
    // breaks a state-only filter.
    expect(marketForJobLocation("Rock Hill, SC", index)).toBe("Charlotte, NC");
    expect(marketForJobLocation("Concord, NC", index)).toBe("Charlotte, NC");
    expect(marketForJobLocation("Charlotte, NC", index)).toBe("Charlotte, NC");
  });

  it("keeps same-state markets separate", () => {
    const charleston = marketForJobLocation("Charleston, SC", index);
    expect(charleston).toBe("Charleston, SC");
    expect(charleston).not.toBe("Charlotte, NC");
  });

  it("matches metro aliases in LinkedIn-style locations", () => {
    expect(marketForJobLocation("Charlotte Metropolitan Area", index)).toBe(
      "Charlotte, NC",
    );
  });

  it("returns null for unknown locations instead of guessing", () => {
    expect(marketForJobLocation("Nowhereville, ZZ", index)).toBeNull();
    expect(marketForJobLocation("Remote", index)).toBeNull();
    expect(marketForJobLocation(null, index)).toBeNull();
  });

  it("derives a company market from its listings by majority", () => {
    const market = deriveMarketFromListings(
      [
        { location: "Rock Hill, SC" },
        { location: "Charlotte, NC" },
        { location: "Charleston, SC" },
      ],
      index,
    );
    expect(market).toBe("Charlotte, NC");
  });

  it("labels the active Admin market from the matching metro preset", () => {
    const charlotteConfig = ALL_CONFIGS.find((c) => c.stateAbbr === "NC")!;
    const preset = Object.values(charlotteConfig.metroPresets).find(
      (p) => p.marketName === "Charlotte",
    )!;
    const settings = {
      geographicScope: "city",
      focusState: "North Carolina",
      focusCity: null,
      focusCities: [preset.metroCities[0]],
      focusCounties: preset.focusCounties,
      metroCities: preset.metroCities,
      metroAliases: preset.metroAliases,
      stateGeoConfig: charlotteConfig,
    } as unknown as GeoFocusSettings;

    expect(activeMarketLabel(settings)).toBe("Charlotte, NC");
  });

  it("falls back to the primary focus city when no preset matches", () => {
    const settings = {
      geographicScope: "city",
      focusState: "Indiana",
      focusCity: null,
      focusCities: ["Fort Wayne"],
      focusCounties: [],
      metroCities: ["Fort Wayne", "New Haven"],
      metroAliases: [],
      stateGeoConfig: null,
    } as unknown as GeoFocusSettings;

    const label = activeMarketLabel(settings);
    expect(label).toMatch(/^Fort Wayne, /);
  });
});
