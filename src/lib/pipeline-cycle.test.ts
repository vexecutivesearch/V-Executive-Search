import { describe, expect, it } from "vitest";
import {
  classifyJobLocation,
  jobLocationInFocus,
} from "@/lib/geo-focus";
import { evaluateIcp } from "@/lib/icp-filter";
import { scoreCompanyPreEnrich } from "@/lib/lead-score";
import { DEFAULT_WPB_METRO_CITIES } from "@/lib/metro-defaults";
import type { pipelineSettings } from "@/lib/db/schema";

function wpbSettings(): typeof pipelineSettings.$inferSelect {
  return {
    id: "test",
    geographicScope: "city",
    focusState: "Florida",
    focusCity: "West Palm Beach",
    focusCities: ["West Palm Beach"],
    focusCounty: null,
    focusCounties: [],
    metroCities: [...DEFAULT_WPB_METRO_CITIES],
    metroAliases: ["palm beach county"],
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
  };
}

/** Dry-run pipeline stages without DB or enrichment credits. */
describe("pipeline dry-run cycle", () => {
  it("runs scrape → geo → ICP → score funnel for representative jobs", () => {
    const settings = wpbSettings();
    const scraped = [
      { company: "SBA Communications", location: "Boca Raton, FL", poster: true },
      { company: "Metro Employer", location: "Palm Beach Gardens, FL", poster: false },
      { company: "WPB Local", location: "West Palm Beach, FL", poster: false },
      { company: "Miami Co", location: "Miami, FL", poster: false },
      { company: "Hays", location: "Fort Lauderdale, FL", poster: true },
      { company: "Acme Staffing LLC", location: "Boca Raton, FL", poster: false },
    ];

    const stages = scraped.map((row) => {
      const geo = classifyJobLocation(row.location, settings);
      const geoPass = geo === "in_metro";
      const icp = evaluateIcp({ companyName: row.company, estimatedEmployees: null });
      const icpPass = icp !== "fail";
      const score = scoreCompanyPreEnrich({
        icpStatus: icp,
        hiringSignals: geoPass ? { new_company: true } : {},
        domainConfidence: "low",
        listings: [{ location: row.location }],
        geoSettings: settings,
        hrOnlyDeprioritize: false,
        hasLinkedInPoster: row.poster,
      });
      const backlogEligible =
        geoPass && icpPass && score >= 0 && row.company !== "Hays";
      return { ...row, geo, geoPass, icp, icpPass, score, backlogEligible };
    });

    const boca = stages.find((s) => s.company === "SBA Communications")!;
    const pbg = stages.find((s) => s.company === "Metro Employer")!;
    const wpb = stages.find((s) => s.company === "WPB Local")!;
    const miami = stages.find((s) => s.company === "Miami Co")!;
    const hays = stages.find((s) => s.company === "Hays")!;
    const staffing = stages.find((s) => s.company === "Acme Staffing LLC")!;

    expect(boca.geoPass && boca.backlogEligible).toBe(true);
    expect(pbg.geoPass).toBe(true);
    expect(wpb.geoPass).toBe(true);
    expect(miami.geoPass).toBe(false);
    expect(hays.icp).toBe("fail");
    expect(staffing.icp).toBe("fail");
    expect(boca.score).toBeGreaterThan(miami.score);

    const funnel = {
      scraped: stages.length,
      geoPass: stages.filter((s) => s.geoPass).length,
      icpPass: stages.filter((s) => s.icpPass).length,
      backlogEligible: stages.filter((s) => s.backlogEligible).length,
    };
    expect(funnel).toEqual({
      scraped: 6,
      geoPass: 5,
      icpPass: 4,
      backlogEligible: 3,
    });
  });
});
