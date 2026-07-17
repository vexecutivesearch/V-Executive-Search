import { describe, expect, it } from "vitest";
import { classifyJobLocation, jobLocationInFocus } from "@/lib/geo-focus";
import {
  REVIEWABLE_STATE_GEO_EXPANSION,
  reviewNotes,
  toStateGeoConfig,
} from "@/lib/state-geo-expanded-seed";
import { buildGeoZones, formatBoardLocation } from "@/lib/pipeline-config";
import type { pipelineSettings } from "@/lib/db/schema";
import type { StateGeoConfig } from "@/lib/state-geo-config";
import coverage from "@/lib/state-geo-expanded-coverage.json";

function settingsFor(
  config: StateGeoConfig,
  overrides: Partial<typeof pipelineSettings.$inferSelect> = {},
): typeof pipelineSettings.$inferSelect & { stateGeoConfig: StateGeoConfig } {
  return {
    id: "expanded-seed-test",
    geographicScope: "city",
    focusState: config.stateName,
    focusCity: config.defaultFocusCities[0],
    focusCities: config.defaultFocusCities,
    focusCounty: null,
    focusCounties: config.defaultFocusCounties,
    metroCities: config.defaultMetroCities,
    metroAliases: config.defaultMetroAliases,
    notificationEmail: "test@example.com",
    jobBoards: [],
    runRequestedAt: null,
    runClaimedAt: null,
    contactoutSyncRequestedAt: null,
    contactoutCreditsExhaustedAt: null,
    imessageCheckRequestedAt: null,
    dailyEnrichQuota: 25,
    minScoreForEnrich: 60,
    minScoreForPhone: 75,
    lastRunAt: null,
    workerLastSeenAt: null,
    workerCommitSha: null,
    workerBranch: null,
    workerDirty: false,
    workerAgentSummary: null,
    workerStatusPayload: null,
    workerStatusAt: null,
    missedRunAlertSlot: null,
    updatedAt: new Date(),
    stateGeoConfig: config,
    ...overrides,
  };
}

describe("expanded state geo seed", () => {
  it("is generated from source coverage and covers each requested state", () => {
    expect(REVIEWABLE_STATE_GEO_EXPANSION.map((s) => s.stateName)).toEqual([
      "Florida",
      "Texas",
      "North Carolina",
      "Virginia",
      "Ohio",
      "Tennessee",
      "South Carolina",
      "Arizona",
      "Pennsylvania",
      "Illinois",
      "Indiana",
      "Michigan",
      "Colorado",
      "New Jersey",
    ]);
    expect(REVIEWABLE_STATE_GEO_EXPANSION).toHaveLength(14);
    expect(
      REVIEWABLE_STATE_GEO_EXPANSION.reduce(
        (total, state) => total + state.markets.length,
        0,
      ),
    ).toBe(61);
    expect(coverage.states).toHaveLength(14);
  });

  it("does not ship human review notes or guessed geography", () => {
    expect(reviewNotes()).toEqual([]);
    for (const state of REVIEWABLE_STATE_GEO_EXPANSION) {
      for (const market of state.markets) {
        expect(market.sourceNames.length, `${state.stateName}/${market.marketName}`).toBeGreaterThan(0);
        expect(market.focusCounties.every((county) => /,\s*[A-Z]{2}$/.test(county))).toBe(true);
        for (const counties of Object.values(market.cityCountyMap)) {
          expect(counties.length).toBeGreaterThan(0);
          expect(counties.every((county) => market.focusCounties.includes(county))).toBe(true);
        }
      }
    }
  });

  it.each(REVIEWABLE_STATE_GEO_EXPANSION)(
    "$stateName builds capped USPS zones and state-scoped matches for every market",
    (seed) => {
      for (const market of seed.markets) {
        const config = toStateGeoConfig(seed, market.marketName);
        const settings = settingsFor(config);
        const zones = buildGeoZones(settings, config);

        expect(zones.length, `${seed.stateName}/${market.marketName}`).toBeGreaterThan(0);
        expect(zones.length, `${seed.stateName}/${market.marketName}`).toBeLessThanOrEqual(8);
        expect(zones.every((zone) => /,\s*[A-Z]{2}$/.test(zone.location))).toBe(
          true,
        );
        expect(formatBoardLocation(config.defaultFocusCities[0], seed.stateName, config)).toMatch(
          /,\s*[A-Z]{2}$/,
        );

        const inMarket = formatBoardLocation(
          config.defaultFocusCities[0],
          seed.stateName,
          config,
        );
        expect(
          classifyJobLocation(inMarket, settings),
          `${seed.stateName}/${market.marketName}/${inMarket}`,
        ).toBe("in_metro");
        expect(
          jobLocationInFocus(inMarket, settings),
          `${seed.stateName}/${market.marketName}/${inMarket}`,
        ).toBe(true);

        const outOfState =
          seed.stateName === "Florida" ? "Atlanta, GA" : "West Palm Beach, FL";
        expect(jobLocationInFocus(outOfState, settings)).toBe(false);

        const unknownInState = `Unmapped Testville, ${seed.stateAbbr}`;
        expect(classifyJobLocation(unknownInState, settings)).toBe(
          "location_unknown",
        );
        expect(jobLocationInFocus(unknownInState, settings)).toBe(false);
      }
    },
  );

  it("keeps cross-state hub cities in their true state", () => {
    const northCarolina = REVIEWABLE_STATE_GEO_EXPANSION.find(
      (seed) => seed.stateName === "North Carolina",
    );
    expect(northCarolina).toBeDefined();
    const config = toStateGeoConfig(northCarolina!, "Charlotte");
    const settings = settingsFor(config);
    const zones = buildGeoZones(settings, config);

    expect(zones.map((zone) => zone.location)).toContain("Rock Hill, SC");
    expect(classifyJobLocation("Rock Hill, SC", settings)).toBe("in_metro");
    expect(jobLocationInFocus("Rock Hill, NC", settings)).toBe(false);
  });

  it("matches every emitted seed mapping to coverage source rows", () => {
    const coverageByState = new Map(
      coverage.states.map((state) => [state.stateName, state]),
    );

    for (const state of REVIEWABLE_STATE_GEO_EXPANSION) {
      const coverageState = coverageByState.get(state.stateName);
      expect(coverageState, state.stateName).toBeDefined();
      const coverageByMarket = new Map(
        coverageState!.markets.map((market) => [market.marketName, market]),
      );

      for (const market of state.markets) {
        const coverageMarket = coverageByMarket.get(market.marketName);
        expect(coverageMarket, `${state.stateName}/${market.marketName}`).toBeDefined();
        expect(coverageMarket!.sourceRowIds.length).toBeGreaterThan(0);
        expect(coverageMarket!.focusCounties).toEqual(market.focusCounties);

        const includedHubs = new Set(
          coverageMarket!.hubResolutions
            .filter((hub) => hub.included)
            .map((hub) => hub.hub),
        );
        for (const hub of market.scrapeHubs) {
          expect(includedHubs.has(hub), `${state.stateName}/${market.marketName}/${hub}`).toBe(true);
        }
        for (const excluded of coverageMarket!.excludedHubs) {
          expect(excluded.reason).toBeTruthy();
        }
      }
    }
  });

  it("keeps every market preset within the 8-zone scrape cap", () => {
    for (const seed of REVIEWABLE_STATE_GEO_EXPANSION) {
      for (const preset of seed.markets) {
        expect(preset.scrapeHubs.length, `${seed.stateName}/${preset.marketName}`).toBeLessThanOrEqual(8);
      }
    }
  });
});
