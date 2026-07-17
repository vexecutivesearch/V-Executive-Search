import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { classifyJobLocation, jobLocationInFocus } from "@/lib/geo-focus";
import { DEFAULT_WPB_METRO_CITIES } from "@/lib/metro-defaults";
import { getStateGeoConfigForState } from "@/lib/state-geo-config-store";
import {
  buildGeoZones,
  type PipelineSettingsWithGeoConfig,
} from "@/lib/pipeline-config";
import { eq } from "drizzle-orm";

const originalWorkerApiKey = process.env.WORKER_API_KEY;

afterEach(() => {
  if (originalWorkerApiKey == null) {
    delete process.env.WORKER_API_KEY;
  } else {
    process.env.WORKER_API_KEY = originalWorkerApiKey;
  }
  vi.restoreAllMocks();
});

function baseSettings(
  overrides: Partial<PipelineSettingsWithGeoConfig> = {},
): PipelineSettingsWithGeoConfig {
  return {
    id: "test",
    geographicScope: "city",
    focusState: "Florida",
    focusCity: "West Palm Beach",
    focusCities: ["West Palm Beach"],
    focusCounty: null,
    focusCounties: ["Palm Beach", "Broward"],
    metroCities: [...DEFAULT_WPB_METRO_CITIES],
    metroAliases: ["palm beach county", "west palm beach metropolitan area"],
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

describe("Georgia geo safe verification", () => {
  it("DB-backed Florida config preserves legacy WPB scrape zones and matches", async () => {
    const dbFlorida = await getStateGeoConfigForState("Florida");
    const legacySettings = baseSettings();
    const dbBackedSettings = baseSettings({
      focusCounties: dbFlorida.defaultFocusCounties,
      metroCities: dbFlorida.defaultMetroCities,
      metroAliases: dbFlorida.defaultMetroAliases,
      stateGeoConfig: dbFlorida,
    });

    expect(dbFlorida.defaultMetroCities).toEqual([...DEFAULT_WPB_METRO_CITIES]);
    expect(dbFlorida.defaultFocusCounties).toEqual(["Palm Beach", "Broward"]);
    expect(buildGeoZones(dbBackedSettings, dbFlorida)).toEqual(
      buildGeoZones(legacySettings, dbFlorida),
    );

    const locations = [
      "West Palm Beach, FL",
      "Boca Raton, FL",
      "Fort Lauderdale, FL",
      "Miami, FL",
      "Fictitious Village, FL",
    ];
    for (const location of locations) {
      expect(classifyJobLocation(location, dbBackedSettings)).toBe(
        classifyJobLocation(location, legacySettings),
      );
      expect(jobLocationInFocus(location, dbBackedSettings)).toBe(
        jobLocationInFocus(location, legacySettings),
      );
    }
  });

  it.runIf(Boolean(process.env.DATABASE_URL))(
    "pipeline config route reads fresh DB settings without an in-process cache",
    async () => {
      process.env.WORKER_API_KEY = "test-worker-key";
      const { getOrCreateSettings } = await import("@/lib/pipeline-config");
      const { GET } = await import("@/app/api/pipeline/config/route");

      const settings = await getOrCreateSettings();
      const originalQuota = settings.dailyEnrichQuota;
      const temporaryQuota = originalQuota === 37 ? 38 : 37;

      try {
        await db
          .update(pipelineSettings)
          .set({ dailyEnrichQuota: temporaryQuota, updatedAt: new Date() })
          .where(eq(pipelineSettings.id, settings.id));

        const response = await GET(
          new Request("http://localhost/api/pipeline/config", {
            headers: { Authorization: "Bearer test-worker-key" },
          }),
        );
        const config = await response.json();

        expect(response.status).toBe(200);
        expect(config.enrichment.daily_enrich_quota).toBe(temporaryQuota);
      } finally {
        await db
          .update(pipelineSettings)
          .set({ dailyEnrichQuota: originalQuota, updatedAt: new Date() })
          .where(eq(pipelineSettings.id, settings.id));
      }
    },
  );
});
