import { describe, expect, it } from "vitest";
import {
  augmentScrapeFunnelWithGeo,
  formatPerSearchFunnelLine,
  formatRunFunnelLine,
  validateFunnelInvariants,
} from "@/lib/pipeline-funnel";
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
    contactoutSyncRequestedAt: null,
    imessageCheckRequestedAt: null,
    dailyEnrichQuota: 25,
    minScoreForEnrich: 60,
    minScoreForPhone: 75,
    lastRunAt: null,
    workerLastSeenAt: null,
    missedRunAlertSlot: null,
    updatedAt: new Date(),
  };
}

describe("per-search funnel", () => {
  it("formats draws → union → in-focus separately", () => {
    const line = formatPerSearchFunnelLine({
      search: "HR Director — West Palm Beach, Florida",
      linkedin_draws: [20, 18, 15],
      linkedin_union: 24,
      linkedin_in_focus: 7,
    });
    expect(line).toBe(
      "HR Director: [20,18,15] → union 24 → in-focus 7",
    );
  });

  it("computes in-focus from this run listings without changing union", () => {
    const search = "HR Director — West Palm Beach, Florida";
    const funnel = augmentScrapeFunnelWithGeo(
      {
        linkedin_per_search: [
          {
            search,
            linkedin_draws: [7, 6, 7],
            linkedin_union: 8,
          },
        ],
      },
      [
        {
          searchName: search,
          board: "linkedin",
          location: "Palm Beach Gardens, FL",
          url: "https://linkedin.com/jobs/view/1",
        },
        {
          searchName: search,
          board: "linkedin",
          location: "Miami, FL",
          url: "https://linkedin.com/jobs/view/2",
        },
      ],
      wpbSettings(),
    );
    expect(funnel.linkedin_per_search?.[0]?.linkedin_union).toBe(8);
    expect(funnel.linkedin_per_search?.[0]?.linkedin_in_focus).toBe(1);
    expect(funnel.linkedin_per_search?.[0]?.linkedin_union_payload).toBe(2);
  });

  it("includes per-title lines in run funnel", () => {
    const line = formatRunFunnelLine({
      scrape_total: 40,
      scrape_linkedin_deduped: 35,
      poster_parsed: 2,
      linkedin_per_search: [
        {
          search: "Head of Talent — West Palm Beach, Florida",
          linkedin_draws: [18, 20, 22],
          linkedin_union: 25,
          linkedin_in_focus: 24,
        },
      ],
    });
    expect(line).toContain(
      "Head of Talent: [18,20,22] → union 25 → in-focus 24",
    );
  });

  it("flags union < max(draw) invariant violations", () => {
    const funnel = validateFunnelInvariants({
      linkedin_per_search: [
        {
          search: "HR Director — West Palm Beach, Florida",
          linkedin_draws: [20, 18, 15],
          linkedin_union: 7,
          linkedin_in_focus: 7,
        },
      ],
    });
    expect(funnel.funnel_invariant_violations).toEqual([
      "HR Director: union 7 < max(draw) 20",
    ]);
    expect(formatRunFunnelLine(funnel)).toContain("⚠");
  });

  it("flags in-focus > union invariant violations", () => {
    const funnel = validateFunnelInvariants({
      linkedin_per_search: [
        {
          search: "Head of Talent — West Palm Beach, Florida",
          linkedin_draws: [10, 10, 10],
          linkedin_union: 12,
          linkedin_in_focus: 15,
        },
      ],
    });
    expect(funnel.funnel_invariant_violations).toContain(
      "Head of Talent: in-focus 15 > union 12",
    );
  });
});
