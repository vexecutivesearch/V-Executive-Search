import { describe, expect, it } from "vitest";
import {
  buildGeoZones,
  formatBoardLocation,
  googleSearchTerm,
} from "@/lib/pipeline-config";
import { getDefaultGeoSelection, getStateGeoConfig } from "@/lib/state-geo-config";
import type { pipelineSettings } from "@/lib/db/schema";

describe("googleSearchTerm (broad market scan)", () => {
  it("builds all-roles NL query with FL + last week", () => {
    expect(googleSearchTerm(" ", "West Palm Beach, FL", 168)).toBe(
      "jobs near West Palm Beach, FL posted in the last week",
    );
  });

  it("builds bucket NL query — not contact titles", () => {
    expect(googleSearchTerm("manager", "Boca Raton, FL", 168)).toBe(
      "manager jobs near Boca Raton, FL posted in the last week",
    );
  });

  it("uses yesterday window only for ≤24h", () => {
    expect(googleSearchTerm("", "Miami, FL", 24)).toBe(
      "jobs near Miami, FL posted since yesterday",
    );
  });
});

describe("formatBoardLocation", () => {
  it("uses FL abbreviation", () => {
    expect(formatBoardLocation("West Palm Beach", "Florida")).toBe(
      "West Palm Beach, FL",
    );
  });

  it("uses GA abbreviation from state geo config", () => {
    const config = getStateGeoConfig("Georgia");
    expect(formatBoardLocation("Atlanta", "Georgia", config)).toBe(
      "Atlanta, GA",
    );
  });
});

describe("buildGeoZones", () => {
  function settings(
    overrides: Partial<typeof pipelineSettings.$inferSelect> = {},
  ): typeof pipelineSettings.$inferSelect {
    const gaDefaults = getDefaultGeoSelection("Georgia", "Atlanta");
    return {
      id: "test",
      geographicScope: "city",
      focusState: "Georgia",
      focusCity: "Atlanta",
      focusCities: gaDefaults.focusCities,
      focusCounty: null,
      focusCounties: gaDefaults.focusCounties,
      metroCities: gaDefaults.metroCities,
      metroAliases: gaDefaults.metroAliases,
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
      ...overrides,
    };
  }

  it("builds capped Georgia city scrape zones only", () => {
    const zones = buildGeoZones(settings(), getStateGeoConfig("Georgia"));
    expect(zones).toHaveLength(8);
    expect(zones.map((zone) => zone.location)).toEqual([
      "Atlanta, GA",
      "Sandy Springs, GA",
      "Marietta, GA",
      "Alpharetta, GA",
      "Roswell, GA",
      "Duluth, GA",
      "Norcross, GA",
      "Decatur, GA",
    ]);
  });

  it("state-change defaults do not retain Florida metro selections", () => {
    const defaults = getDefaultGeoSelection("Georgia", "Atlanta");
    expect(defaults.focusCities).toEqual(["Atlanta"]);
    expect(defaults.metroCities).toContain("Marietta");
    expect(defaults.metroCities).not.toContain("West Palm Beach");
    expect(defaults.focusCounties).toEqual([
      "Fulton",
      "DeKalb",
      "Cobb",
      "Gwinnett",
    ]);
  });
});
