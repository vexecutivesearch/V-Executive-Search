import { describe, expect, it } from "vitest";
import {
  classifyJobLocation,
  jobLocationInFocus,
} from "@/lib/geo-focus";
import { evaluateIcp, isStaffingAgency } from "@/lib/icp-filter";
import {
  normalizeJobLocationString,
  parseJobLocation,
} from "@/lib/location-match";
import { DEFAULT_WPB_METRO_CITIES } from "@/lib/metro-defaults";
import type { pipelineSettings } from "@/lib/db/schema";

function wpbSettings(
  overrides: Partial<typeof pipelineSettings.$inferSelect> = {},
): typeof pipelineSettings.$inferSelect {
  return {
    id: "test",
    geographicScope: "city",
    focusState: "Florida",
    focusCity: "West Palm Beach",
    focusCities: ["West Palm Beach"],
    focusCounty: null,
    focusCounties: [],
    metroCities: [...DEFAULT_WPB_METRO_CITIES],
    metroAliases: ["palm beach county", "west palm beach metropolitan area"],
    notificationEmail: "test@example.com",
    jobBoards: [],
    runRequestedAt: null,
    contactoutSyncRequestedAt: null,
    imessageCheckRequestedAt: null,
    dailyEnrichQuota: 25,
    minScoreForEnrich: 60,
    minScoreForPhone: 75,
    lastRunAt: null,
    workerLastSeenAt: null,
    missedRunAlertSlot: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

const METRO_PASS_CASES = [
  ["West Palm Beach, FL", "West Palm Beach"],
  ["Boca Raton, FL", "Boca Raton"],
  ["Palm Beach Gardens, FL", "Palm Beach Gardens"],
  ["Boynton Beach, Florida", "Boynton Beach"],
  ["Delray Beach, FL, US", "Delray Beach"],
  ["Jupiter, FL", "Jupiter"],
  ["Wellington, FL", "Wellington"],
  ["Lake Worth, FL", "Lake Worth"],
  ["Riviera Beach, FL", "Riviera Beach"],
  ["Royal Palm Beach, FL", "Royal Palm Beach"],
  ["Greenacres, FL", "Greenacres"],
  ["Palm Springs, FL", "Palm Springs"],
  ["Lake Park, FL", "Lake Park"],
  ["North Palm Beach, FL", "North Palm Beach"],
  ["Juno Beach, FL", "Juno Beach"],
  ["Tequesta, FL", "Tequesta"],
  ["Loxahatchee, FL, US", "Loxahatchee"],
  ["Belle Glade, FL", "Belle Glade"],
  ["Palm Beach, FL", "Palm Beach"],
  ["Greater Boca Raton Area", "Greater Boca Raton Area"],
  ["West Palm Beach Metropolitan Area", "WPB metro label"],
  ["Palm Beach County, FL", "Palm Beach County"],
  ["On-site\nBoca Raton, FL", "LinkedIn on-site prefix"],
] as const;

const METRO_REJECT_CASES = [
  ["Miami, FL", "Miami"],
  ["Orlando, FL", "Orlando"],
  ["Tampa, FL", "Tampa"],
] as const;

describe("geo normalization", () => {
  it.each(METRO_PASS_CASES)(
    "accepts in-metro location %s (%s)",
    (location) => {
      const settings = wpbSettings();
      expect(classifyJobLocation(location, settings)).toBe("in_metro");
      expect(jobLocationInFocus(location, settings)).toBe(true);
    },
  );

  it.each(METRO_REJECT_CASES)(
    "rejects out-of-metro location %s (%s)",
    (location) => {
      const settings = wpbSettings();
      expect(classifyJobLocation(location, settings)).toBe("out_of_metro");
      expect(jobLocationInFocus(location, settings)).toBe(false);
    },
  );

  it("routes remote and blank to location_unknown", () => {
    const settings = wpbSettings();
    expect(classifyJobLocation("Remote", settings)).toBe("location_unknown");
    expect(classifyJobLocation("", settings)).toBe("location_unknown");
    expect(classifyJobLocation(null, settings)).toBe("location_unknown");
  });

  it("normalizes LinkedIn on-site prefix", () => {
    const normalized = normalizeJobLocationString("On-site\nBoca Raton, FL");
    expect(parseJobLocation(normalized)?.city).toBe("Boca Raton");
  });

  it("uses admin metro_cities config when set", () => {
    const settings = wpbSettings({
      metroCities: ["Tequesta"],
      focusCities: ["West Palm Beach"],
    });
    expect(jobLocationInFocus("Tequesta, FL", settings)).toBe(true);
    expect(jobLocationInFocus("Boca Raton, FL", settings)).toBe(false);
  });
});

describe("ICP filter", () => {
  it("does not fail when employee size is unknown", () => {
    expect(
      evaluateIcp({
        companyName: "SBA Communications",
        estimatedEmployees: null,
      }),
    ).toBe("unknown");
  });

  it("fails confirmed out-of-band employee size", () => {
    expect(
      evaluateIcp({ companyName: "Acme Corp", estimatedEmployees: 12 }),
    ).toBe("fail");
    expect(
      evaluateIcp({ companyName: "Acme Corp", estimatedEmployees: 800 }),
    ).toBe("fail");
  });

  it("passes in-band employee size", () => {
    expect(
      evaluateIcp({ companyName: "Acme Corp", estimatedEmployees: 120 }),
    ).toBe("pass");
  });

  it("fails known staffing agencies without geo coupling", () => {
    expect(isStaffingAgency("Hays")).toBe(true);
    expect(evaluateIcp({ companyName: "Hays", estimatedEmployees: 100 })).toBe(
      "fail",
    );
  });

  it("does not false-positive staffing on unrelated names", () => {
    expect(isStaffingAgency("SBA Communications")).toBe(false);
    expect(isStaffingAgency("Allegiance Group")).toBe(false);
  });
});
