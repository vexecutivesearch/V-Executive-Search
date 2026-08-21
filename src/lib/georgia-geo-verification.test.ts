import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { pipelineSettings } from "@/lib/db/schema";
import { classifyJobLocation, jobLocationInFocus } from "@/lib/geo-focus";
import { DEFAULT_WPB_METRO_CITIES } from "@/lib/metro-defaults";
import type { StateGeoConfig } from "@/lib/state-geo-config";
import {
  REVIEWABLE_STATE_GEO_EXPANSION,
  toStateGeoConfig,
} from "@/lib/state-geo-expanded-seed";
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
  vi.doUnmock("@/lib/db");
  vi.resetModules();
  vi.restoreAllMocks();
});

/**
 * Load the state geo store with an unreachable database, so the built-in
 * fallback is exercised deterministically instead of whatever a developer's
 * DATABASE_URL happens to point at. Any query — including the insert in
 * seedMissingStateGeoConfigs — throws, which also proves the read path never
 * writes.
 */
async function loadStoreWithoutDatabase() {
  const unreachable = new Proxy(
    {},
    {
      get() {
        throw new Error("database unavailable");
      },
    },
  );
  vi.doMock("@/lib/db", () => ({
    db: unreachable,
    getDb: () => {
      throw new Error("database unavailable");
    },
  }));
  vi.resetModules();
  return import("@/lib/state-geo-config-store");
}

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

function seededFloridaConfig(): StateGeoConfig {
  const seed = REVIEWABLE_STATE_GEO_EXPANSION.find(
    (candidate) => candidate.stateName === "Florida",
  );
  expect(seed).toBeDefined();
  return toStateGeoConfig(seed!);
}

describe("Georgia geo safe verification", () => {
  it("keeps the legacy WPB scrape zones when the state geo store falls back", async () => {
    const { getStateGeoConfigForState } = await loadStoreWithoutDatabase();
    const florida = await getStateGeoConfigForState("Florida");
    const legacySettings = baseSettings();
    const configBackedSettings = baseSettings({
      focusCounties: florida.defaultFocusCounties,
      metroCities: florida.defaultMetroCities,
      metroAliases: florida.defaultMetroAliases,
      stateGeoConfig: florida,
    });

    expect(florida.defaultMetroCities).toEqual([...DEFAULT_WPB_METRO_CITIES]);
    expect(florida.defaultFocusCounties).toEqual(["Palm Beach", "Broward"]);
    expect(buildGeoZones(configBackedSettings, florida)).toEqual(
      buildGeoZones(legacySettings, florida),
    );
    expect(
      buildGeoZones(configBackedSettings, florida).map((zone) => zone.location),
    ).toEqual([
      "West Palm Beach, FL",
      "Boca Raton, FL",
      "Boynton Beach, FL",
      "Delray Beach, FL",
      "Palm Beach Gardens, FL",
      "Jupiter, FL",
      "Wellington, FL",
      "Lake Worth, FL",
    ]);

    const locations = [
      "West Palm Beach, FL",
      "Boca Raton, FL",
      "Fort Lauderdale, FL",
      "Miami, FL",
      "Fictitious Village, FL",
    ];
    for (const location of locations) {
      expect(classifyJobLocation(location, configBackedSettings)).toBe(
        classifyJobLocation(location, legacySettings),
      );
      expect(jobLocationInFocus(location, configBackedSettings)).toBe(
        jobLocationInFocus(location, legacySettings),
      );
    }
  });

  it("seeds Florida from the census-grounded expansion, not the legacy WPB list", () => {
    // The row seedMissingStateGeoConfigs writes for Florida comes from the
    // expanded seed, which deliberately supersedes the legacy hand-kept
    // DEFAULT_WPB_METRO_CITIES: hubs are capped at 8 and counties carry their
    // state. The two lists are meant to differ — do not "reconcile" them.
    const seededFlorida = seededFloridaConfig();

    expect(seededFlorida.defaultMetroCities).toEqual([
      "West Palm Beach",
      "Boca Raton",
      "Boynton Beach",
      "Delray Beach",
      "Palm Beach Gardens",
      "Jupiter",
      "Wellington",
      "Lake Worth Beach",
    ]);
    expect(seededFlorida.defaultFocusCounties).toEqual([
      "Broward, FL",
      "Palm Beach, FL",
    ]);
    expect(seededFlorida.defaultMetroCities).not.toEqual([
      ...DEFAULT_WPB_METRO_CITIES,
    ]);
  });

  it("keeps zone building consistent for a seeded Florida config", () => {
    const seededFlorida = seededFloridaConfig();
    const settings = baseSettings({
      focusCounties: seededFlorida.defaultFocusCounties,
      metroCities: seededFlorida.defaultMetroCities,
      metroAliases: seededFlorida.defaultMetroAliases,
      stateGeoConfig: seededFlorida,
    });

    expect(buildGeoZones(settings, seededFlorida).map((zone) => zone.location))
      .toEqual([
        "West Palm Beach, FL",
        "Boca Raton, FL",
        "Boynton Beach, FL",
        "Delray Beach, FL",
        "Palm Beach Gardens, FL",
        "Jupiter, FL",
        "Wellington, FL",
        "Lake Worth Beach, FL",
      ]);
    expect(classifyJobLocation("West Palm Beach, FL", settings)).toBe(
      "in_metro",
    );
    expect(jobLocationInFocus("Boca Raton, FL", settings)).toBe(true);
    expect(jobLocationInFocus("Atlanta, GA", settings)).toBe(false);
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
