import { describe, expect, it } from "vitest";
import { buildGeoZones, buildGoogleZones } from "@/lib/pipeline-config";
import {
  formatGooglePerQueryLine,
  formatSerpapiMeterLine,
} from "@/lib/pipeline-funnel";
import type { pipelineSettings } from "@/lib/db/schema";
import type { StateGeoConfig } from "@/lib/state-geo-config";

const DFW_HUBS = [
  "Dallas",
  "Fort Worth",
  "Arlington",
  "Plano",
  "Irving",
  "Frisco",
  "Denton",
  "McKinney",
];

const CHARLOTTE_HUBS = [
  "Charlotte",
  "Concord",
  "Gastonia",
  "Huntersville",
  "Matthews",
  "Mooresville",
  "Rock Hill, SC",
  "Monroe",
];

function baseSettings(
  overrides: Partial<typeof pipelineSettings.$inferSelect>,
): typeof pipelineSettings.$inferSelect {
  return {
    id: "test",
    geographicScope: "city",
    focusState: "Texas",
    focusCity: null,
    focusCities: ["Dallas"],
    focusCounty: null,
    focusCounties: [],
    metroCities: [...DFW_HUBS],
    metroAliases: [],
    notificationEmail: "test@example.com",
    jobBoards: [],
    emailReportPreferences: null,
    contactTitles: [],
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
    ...overrides,
  };
}

function texasConfig(googleZones?: string[]): StateGeoConfig {
  return {
    stateName: "Texas",
    stateAbbr: "TX",
    cities: [...DFW_HUBS],
    counties: [],
    defaultFocusCities: ["Dallas"],
    defaultFocusCounties: [],
    defaultMetroCities: [...DFW_HUBS],
    defaultMetroAliases: [],
    cityCountyMap: {},
    metroPresets: {
      "dallas-fort worth": {
        marketName: "Dallas-Fort Worth",
        metroCities: [...DFW_HUBS],
        metroAliases: ["dfw"],
        focusCounties: [],
        ...(googleZones ? { googleZones } : {}),
      },
    },
  };
}

function ncConfig(): StateGeoConfig {
  return {
    stateName: "North Carolina",
    stateAbbr: "NC",
    cities: [...CHARLOTTE_HUBS],
    counties: [],
    defaultFocusCities: ["Charlotte"],
    defaultFocusCounties: [],
    defaultMetroCities: [...CHARLOTTE_HUBS],
    defaultMetroAliases: [],
    cityCountyMap: {},
    metroPresets: {
      charlotte: {
        marketName: "Charlotte",
        metroCities: [...CHARLOTTE_HUBS],
        metroAliases: ["charlotte metro"],
        focusCounties: [],
        // No googleZones — default collapse applies (metro center only).
      },
    },
  };
}

describe("buildGoogleZones (zone collapse — Google/SerpApi only)", () => {
  it("free boards keep all 8 hubs; Google collapses to metro center by default", () => {
    const config = ncConfig();
    const settings = baseSettings({
      focusState: "North Carolina",
      focusCities: ["Charlotte"],
      metroCities: [...CHARLOTTE_HUBS],
      stateGeoConfig: config,
    } as Partial<typeof pipelineSettings.$inferSelect>);

    const zones = buildGeoZones(settings, config);
    expect(zones).toHaveLength(8); // Indeed/LinkedIn coverage untouched

    const googleZones = buildGoogleZones(settings, config, zones);
    expect(googleZones.map((z) => z.label)).toEqual(["Charlotte, NC"]);
  });

  it("sprawling metros query the configured second far-edge zone (DFW)", () => {
    const config = texasConfig(["Dallas", "Fort Worth"]);
    const settings = baseSettings({
      stateGeoConfig: config,
    } as Partial<typeof pipelineSettings.$inferSelect>);

    const zones = buildGeoZones(settings, config);
    expect(zones).toHaveLength(8);

    const googleZones = buildGoogleZones(settings, config, zones);
    expect(googleZones.map((z) => z.label)).toEqual([
      "Dallas, TX",
      "Fort Worth, TX",
    ]);
  });

  it("falls back to metro center when configured zones match nothing", () => {
    const config = texasConfig(["Nowhere"]);
    const settings = baseSettings({
      stateGeoConfig: config,
    } as Partial<typeof pipelineSettings.$inferSelect>);
    const zones = buildGeoZones(settings, config);
    const googleZones = buildGoogleZones(settings, config, zones);
    expect(googleZones.map((z) => z.label)).toEqual(["Dallas, TX"]);
  });

  it("does not collapse non-city scopes (already 1–few zones)", () => {
    const config = texasConfig();
    const settings = baseSettings({
      geographicScope: "state",
      stateGeoConfig: config,
    } as Partial<typeof pipelineSettings.$inferSelect>);
    const zones = buildGeoZones(settings, config);
    const googleZones = buildGoogleZones(settings, config, zones);
    expect(googleZones).toEqual(zones);
  });
});

describe("SerpApi meter display", () => {
  it("formats per-run + month-to-date vs plan", () => {
    expect(
      formatSerpapiMeterLine({
        serpapi_searches: 42,
        serpapi_month_to_date: 3812,
        serpapi_monthly_plan: 15000,
      }),
    ).toBe("google: 42 searches · 3,812 this month · plan 15,000");
  });

  it("surfaces failed searches (retry storms must be visible)", () => {
    expect(
      formatSerpapiMeterLine({
        serpapi_searches: 10,
        serpapi_searches_failed: 4,
        serpapi_month_to_date: 100,
        serpapi_monthly_plan: 15000,
      }),
    ).toContain("(4 failed)");
  });

  it("returns null when the run has no SerpApi data (older funnels)", () => {
    expect(formatSerpapiMeterLine({})).toBeNull();
  });

  it("returns null when SerpApi never ran (all-zero worker funnel)", () => {
    expect(
      formatSerpapiMeterLine({
        serpapi_searches: 0,
        serpapi_searches_failed: 0,
        serpapi_month_to_date: 0,
        serpapi_monthly_plan: 0,
      }),
    ).toBeNull();
  });

  it("still shows the month-to-date on schedule-gated runs (0 searches)", () => {
    expect(
      formatSerpapiMeterLine({
        serpapi_searches: 0,
        serpapi_month_to_date: 3812,
        serpapi_monthly_plan: 15000,
      }),
    ).toBe("google: 0 searches · 3,812 this month · plan 15,000");
  });

  it("formats per-query pagination with per-page new ratios", () => {
    const line = formatGooglePerQueryLine({
      search: "Market scan — Charlotte, NC",
      pages: [
        { page: 1, results: 10, new: 9, new_ratio: 0.9 },
        { page: 2, results: 10, new: 2, new_ratio: 0.2 },
      ],
      new_listings: 11,
      new_companies: 3,
      cold_start: true,
      stop_reason: "yield_below_threshold",
    });
    expect(line).toBe(
      "Market scan (cold): 2p [0.90, 0.20] → 11 new / 3 new cos · stop: yield_below_threshold",
    );
  });
});
