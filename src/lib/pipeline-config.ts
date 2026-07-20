import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailyRuns, pipelineSettings, searchProfiles } from "@/lib/db/schema";
import { activeMarketLabel } from "@/lib/market-attribution";
import { serpapiMonthToDate, serpapiPeriodStart, serpapiPlanConfig } from "@/lib/serpapi-usage";
import { TARGET_TITLES } from "@/lib/enrichment-config";
import { DEFAULT_JOB_BOARDS, resolveJobBoards } from "@/lib/job-boards";
import { backfillLinkedinDistanceDefaults } from "@/lib/search-profile-defaults";
import { SUGGESTED_FOCUS_KEYWORDS } from "@/lib/scrape-keyword-suggestions";
import {
  getDefaultGeoSelection,
  getStateAbbreviation,
  getStateGeoConfig,
  type StateGeoConfig,
} from "@/lib/state-geo-config";
import { getStateGeoConfigForState } from "@/lib/state-geo-config-store";

/**
 * Broad geo hiring signals for JobSpy/SerpAPI — not contact titles.
 * Space term = location-first "all roles" pull; named buckets fill common roles.
 * Focus keywords (Legal / Marketing / …) are additive OR queries on top of these.
 */
const BROAD_BUCKET_SEARCHES = [
  {
    name: "Market scan",
    searchTerm: " ",
    sortOrder: 0,
    linkedinDistance: 25,
    resultsWanted: 100,
  },
  {
    name: "Manager",
    searchTerm: "manager",
    sortOrder: 1,
    linkedinDistance: 25,
    resultsWanted: 50,
  },
  {
    name: "Director",
    searchTerm: "director",
    sortOrder: 2,
    linkedinDistance: 25,
    resultsWanted: 50,
  },
  {
    name: "Coordinator",
    searchTerm: "coordinator",
    sortOrder: 3,
    linkedinDistance: 25,
    resultsWanted: 50,
  },
  {
    name: "Specialist",
    searchTerm: "specialist",
    sortOrder: 4,
    linkedinDistance: 25,
    resultsWanted: 50,
  },
  {
    name: "Assistant",
    searchTerm: "assistant",
    sortOrder: 5,
    linkedinDistance: 25,
    resultsWanted: 50,
  },
  {
    name: "Analyst",
    searchTerm: "analyst",
    sortOrder: 6,
    linkedinDistance: 25,
    resultsWanted: 50,
  },
  {
    name: "Sales",
    searchTerm: "sales",
    sortOrder: 7,
    linkedinDistance: 25,
    resultsWanted: 50,
  },
] as const;

/** Focus keywords — run in addition to broad buckets (OR, never replaces them). */
const FOCUS_KEYWORD_SEARCHES = SUGGESTED_FOCUS_KEYWORDS.map((s, i) => ({
  name: s.name,
  searchTerm: s.searchTerm,
  sortOrder: 20 + i,
  linkedinDistance: 25,
  resultsWanted: 50,
}));

const DEFAULT_SEARCHES = [...BROAD_BUCKET_SEARCHES, ...FOCUS_KEYWORD_SEARCHES];

export { BROAD_BUCKET_SEARCHES, FOCUS_KEYWORD_SEARCHES, DEFAULT_SEARCHES };
/** Old Admin profiles that were contact titles misused as scrape queries. */
const LEGACY_CONTACT_AS_SEARCH = new Set([
  "hr director",
  "vp people",
  "head of talent",
]);

export type GeoZone = {
  label: string;
  location: string;
  googleSuffix: string;
};

export type PipelineSettingsWithGeoConfig = Awaited<
  ReturnType<typeof getOrCreateSettings>
> & {
  stateGeoConfig?: StateGeoConfig | null;
};

function normalizeList(values: string[] | null | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function normalizeContactTitles(
  values: string[] | null | undefined,
): string[] {
  const list = normalizeList(values);
  return list.length ? list : [...TARGET_TITLES];
}

/** Remove duplicate search profiles (keep lowest sort_order / oldest id). */
export async function dedupeSearchProfiles(): Promise<number> {
  const rows = await db
    .select()
    .from(searchProfiles)
    .orderBy(searchProfiles.sortOrder, searchProfiles.createdAt);

  const seen = new Set<string>();
  const toDelete: string[] = [];

  for (const row of rows) {
    const key = row.searchTerm.trim().toLowerCase() || " ";
    if (seen.has(key)) {
      toDelete.push(row.id);
    } else {
      seen.add(key);
    }
  }

  if (toDelete.length) {
    await db.delete(searchProfiles).where(inArray(searchProfiles.id, toDelete));
  }

  return toDelete.length;
}

/**
 * One-time: replace HR/People contact titles used as JobSpy queries with
 * broad market-scan buckets. Skips if any non-legacy active profile exists.
 */
export async function migrateLegacyContactTitleSearches(): Promise<boolean> {
  const rows = await db.select().from(searchProfiles);
  if (!rows.length) return false;

  const hasBroad = rows.some((r) => {
    const term = r.searchTerm.trim().toLowerCase();
    const name = r.name.trim().toLowerCase();
    return name.includes("market scan") || term === "" || term === "manager";
  });
  if (hasBroad) return false;

  const active = rows.filter((r) => r.isActive);
  if (!active.length) return false;
  if (
    !active.every((r) =>
      LEGACY_CONTACT_AS_SEARCH.has(r.searchTerm.trim().toLowerCase()),
    )
  ) {
    return false;
  }

  await db.delete(searchProfiles);
  await db.insert(searchProfiles).values(
    DEFAULT_SEARCHES.map((s) => ({
      name: s.name,
      searchTerm: s.searchTerm,
      isActive: true,
      sortOrder: s.sortOrder,
      linkedinDistance: s.linkedinDistance,
      resultsWanted: s.resultsWanted,
    })),
  );
  return true;
}

/** Insert any DEFAULT_SEARCHES missing from DB (e.g. Paralegal / Attorney). */
export async function backfillMissingDefaultSearchProfiles(): Promise<number> {
  const existing = await db.select().from(searchProfiles);
  const have = new Set(
    existing.map((r) => r.searchTerm.trim().toLowerCase() || " "),
  );
  const missing = DEFAULT_SEARCHES.filter((s) => {
    const key = s.searchTerm.trim().toLowerCase() || " ";
    return !have.has(key);
  });
  if (!missing.length) return 0;
  await db.insert(searchProfiles).values(
    missing.map((s) => ({
      name: s.name,
      searchTerm: s.searchTerm,
      isActive: true,
      sortOrder: s.sortOrder,
      linkedinDistance: s.linkedinDistance,
      resultsWanted: s.resultsWanted,
    })),
  );
  return missing.length;
}

export async function getOrCreateSettings() {
  let [settings] = await db.select().from(pipelineSettings).limit(1);
  const floridaDefaults = getDefaultGeoSelection("Florida");

  if (!settings) {
    [settings] = await db
      .insert(pipelineSettings)
      .values({
        geographicScope: "city",
        focusState: "Florida",
        focusCity: "West Palm Beach",
        focusCities: floridaDefaults.focusCities,
        focusCounties: floridaDefaults.focusCounties,
        metroCities: floridaDefaults.metroCities,
        metroAliases: floridaDefaults.metroAliases,
        notificationEmail: "hello@proventheory.co",
        jobBoards: [...DEFAULT_JOB_BOARDS],
        contactTitles: [...TARGET_TITLES],
      })
      .returning();
  } else if (!normalizeList(settings.metroCities).length) {
    const defaults = getDefaultGeoSelection(settings.focusState ?? "Florida");
    [settings] = await db
      .update(pipelineSettings)
      .set({
        metroCities: defaults.metroCities,
        metroAliases: defaults.metroAliases,
        updatedAt: new Date(),
      })
      .where(eq(pipelineSettings.id, settings.id))
      .returning();
  }

  if (!normalizeList(settings.contactTitles).length) {
    [settings] = await db
      .update(pipelineSettings)
      .set({
        contactTitles: [...TARGET_TITLES],
        updatedAt: new Date(),
      })
      .where(eq(pipelineSettings.id, settings.id))
      .returning();
  }

  const existingProfiles = await db.select().from(searchProfiles).limit(1);
  if (!existingProfiles.length) {
    await db.insert(searchProfiles).values(
      DEFAULT_SEARCHES.map((s) => ({
        name: s.name,
        searchTerm: s.searchTerm,
        isActive: true,
        sortOrder: s.sortOrder,
        linkedinDistance: s.linkedinDistance,
        resultsWanted: s.resultsWanted,
      })),
    );
  } else {
    await migrateLegacyContactTitleSearches();
    await backfillMissingDefaultSearchProfiles();
  }

  await dedupeSearchProfiles();
  await backfillLinkedinDistanceDefaults();

  const boards = resolveJobBoards(settings.jobBoards);
  if (!settings.jobBoards?.length) {
    [settings] = await db
      .update(pipelineSettings)
      .set({ jobBoards: boards, updatedAt: new Date() })
      .where(eq(pipelineSettings.id, settings.id))
      .returning();
  }

  return settings;
}

export async function getActiveSearchProfiles() {
  await dedupeSearchProfiles();
  return db
    .select()
    .from(searchProfiles)
    .where(eq(searchProfiles.isActive, true))
    .orderBy(searchProfiles.sortOrder);
}

export async function getAllSearchProfiles() {
  await dedupeSearchProfiles();
  return db.select().from(searchProfiles).orderBy(searchProfiles.sortOrder);
}

/** Build geographic zones from settings (multi-select geofence). */
export function buildGeoZones(
  settings: PipelineSettingsWithGeoConfig,
  stateGeoConfig: StateGeoConfig = getStateGeoConfig(settings.focusState),
): GeoZone[] {
  const state = settings.focusState || "Florida";
  const config = settings.stateGeoConfig ?? stateGeoConfig;
  const zones: GeoZone[] = [];

  if (settings.geographicScope === "national") {
    zones.push({
      label: "United States",
      location: "United States",
      googleSuffix: "United States",
    });
    return zones;
  }

  if (settings.geographicScope === "state") {
    zones.push({
      label: state,
      location: state,
      googleSuffix: state,
    });
    return zones;
  }

  if (settings.geographicScope === "county") {
    const counties = normalizeList(settings.focusCounties);
    const legacy = settings.focusCounty?.trim();
    const list = counties.length ? counties : legacy ? [legacy] : [];

    for (const county of list) {
      const loc = formatCountyLocation(county, state, config);
      zones.push({
        label: loc,
        location: loc,
        googleSuffix: loc,
      });
    }
    return zones.length
      ? zones
      : [
          {
            label: `${state} (all counties)`,
            location: state,
            googleSuffix: state,
          },
        ];
  }

  // city scope: focus cities first, then Admin metro expansion (nearby hubs).
  // Cap keeps LinkedIn/Indeed multi-draw runs from exploding.
  // Never hardcode a market — empty focus falls back to configured metro, then seed.
  const MAX_SCRAPE_CITY_ZONES = 8;
  const focus = normalizeList(settings.focusCities);
  const legacyCity = settings.focusCity?.trim();
  const metro = normalizeList(settings.metroCities);
  const defaults = getDefaultGeoSelection(state, legacyCity, [config]);
  const focusList = focus.length
    ? focus
    : legacyCity
      ? [legacyCity]
      : metro.length
        ? [metro[0]]
        : defaults.focusCities;
  const ordered: string[] = [];
  for (const city of [...focusList, ...metro]) {
    const key = city.trim().toLowerCase();
    if (!key) continue;
    if (ordered.some((c) => c.toLowerCase() === key)) continue;
    ordered.push(city.trim());
  }
  const list = ordered.slice(0, MAX_SCRAPE_CITY_ZONES);

  for (const city of list) {
    const loc = formatBoardLocation(city, state, config);
    zones.push({
      label: loc,
      location: loc,
      googleSuffix: loc,
    });
  }

  return zones;
}

function normalizedSetEquals(a: string[], b: string[]): boolean {
  const setA = new Set(a.map((v) => v.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(b.map((v) => v.trim().toLowerCase()).filter(Boolean));
  if (setA.size !== setB.size) return false;
  for (const value of setA) if (!setB.has(value)) return false;
  return true;
}

/** Metro preset currently active in Admin (matched on metro city set). */
function activeMetroPreset(
  settings: PipelineSettingsWithGeoConfig,
  config: StateGeoConfig,
) {
  const metro = normalizeList(settings.metroCities);
  if (!metro.length) return null;
  for (const preset of Object.values(config.metroPresets ?? {})) {
    if (normalizedSetEquals(metro, preset.metroCities ?? [])) return preset;
  }
  return null;
}

/**
 * Zone collapse for Google/SerpApi: Google Jobs is a paid, wide-radius
 * aggregator — querying all 8 hub cities pays 8× for overlapping results.
 * Google gets 1–2 zones per market (metro center; optional far-edge hub for
 * sprawling metros, configured per market via metroPresets.googleZones).
 * Free boards (Indeed/LinkedIn) keep the FULL hub list — their geo needs it
 * and they cost nothing. Dedup/resight/ingest are unchanged.
 */
export function buildGoogleZones(
  settings: PipelineSettingsWithGeoConfig,
  stateGeoConfig: StateGeoConfig = getStateGeoConfig(settings.focusState),
  zones: GeoZone[] = buildGeoZones(settings, stateGeoConfig),
): GeoZone[] {
  if (!zones.length) return [];
  // Only the 8-hub city scope multiplies queries; other scopes are 1–few zones.
  if (settings.geographicScope !== "city") return zones;

  const config = settings.stateGeoConfig ?? stateGeoConfig;
  const preset = activeMetroPreset(settings, config);
  const configured = normalizeList(preset?.googleZones);
  if (!configured.length) {
    // Default collapse: metro center only (the first zone).
    return zones.slice(0, 1);
  }

  const wanted = new Set(
    configured.map((city) =>
      formatBoardLocation(city, settings.focusState || "Florida", config)
        .trim()
        .toLowerCase(),
    ),
  );
  const matched = zones.filter((zone) =>
    wanted.has(zone.location.trim().toLowerCase()),
  );
  return matched.length ? matched : zones.slice(0, 1);
}

/** USPS-style place for JobSpy / Google NL ("West Palm Beach, FL"). */
export function formatBoardLocation(
  cityOrPlace: string,
  state: string,
  stateGeoConfig?: StateGeoConfig | null,
): string {
  const abbr = getStateAbbreviation(
    state,
    stateGeoConfig ? [stateGeoConfig] : undefined,
  );
  const place = cityOrPlace
    .trim()
    .replace(new RegExp(`,?\\s*(${abbr}|${state})\\s*$`, "i"), "");
  if (!place) return abbr;
  // Already "City, ST"
  if (/,\s*[A-Z]{2}$/i.test(place)) return place;
  return `${place}, ${abbr}`;
}

function formatCountyLocation(
  county: string,
  state: string,
  stateGeoConfig?: StateGeoConfig | null,
): string {
  const match = county.trim().match(/^(.*?),\s*([A-Z]{2})$/i);
  if (match) return `${match[1].trim()} County, ${match[2].toUpperCase()}`;
  return formatBoardLocation(`${county} County`, state, stateGeoConfig);
}

function googleRecencyPhrase(hoursOld: number): string {
  // Match JobSpy hours_old window — "posted today" is too narrow for a 6AM/6PM pull.
  if (hoursOld <= 24) return "posted since yesterday";
  if (hoursOld <= 72) return "posted in the last 3 days";
  if (hoursOld <= 168) return "posted in the last week";
  return "posted in the last month";
}

/**
 * JobSpy Google needs natural-language built from Admin config — never hardcoded
 * titles or geo. Place comes from the scrape zone (focus + metro hubs);
 * window comes from hours_old (keep wide — last week / 168h — for resilience
 * and repost signals; "new today" is a CRM highlight, not a scrape window).
 *
 * Examples (when Admin geo is WPB metro):
 *   jobs near West Palm Beach, FL posted in the last week
 *   manager jobs near Boca Raton, FL posted in the last week
 */
export function googleSearchTerm(
  searchTerm: string,
  location: string,
  hoursOld = 168,
): string {
  const role = searchTerm.trim();
  const place = location.trim();
  const window = googleRecencyPhrase(hoursOld);
  const head = role ? `${role} jobs` : "jobs";
  if (!place) return `${head} ${window}`;
  return `${head} near ${place} ${window}`;
}

/** Per-board schedule gates — the pipeline itself still runs twice daily. */
export function buildBoardSchedules(): Record<
  string,
  { runs: string[]; days: string }
> {
  const runs = (process.env.GOOGLE_BOARD_RUNS ?? "am")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const days = (process.env.GOOGLE_BOARD_DAYS ?? "weekdays")
    .trim()
    .toLowerCase();
  return {
    // Google (SerpApi, paid): 5 AM run only, weekdays only. In the 6 PM run
    // and on weekends the worker logs board_skipped: schedule_gate — the
    // launchd schedule and every other board are untouched.
    google: { runs: runs.length ? runs : ["am"], days: days || "weekdays" },
  };
}

async function serpapiConfigBlock(marketLabel: string | null) {
  const plan = serpapiPlanConfig();
  let monthToDate = 0;
  let marketLastRunDate: string | null = null;
  try {
    monthToDate = await serpapiMonthToDate(plan.renewalDay);
  } catch (error) {
    console.warn("serpapi month-to-date lookup failed", error);
  }
  try {
    // Cold-start detection: when did this market last scrape anything?
    const marketFilter = marketLabel
      ? and(eq(dailyRuns.market, marketLabel), gt(dailyRuns.listingsScraped, 0))
      : gt(dailyRuns.listingsScraped, 0);
    const [row] = await db
      .select({ last: sql<string | null>`max(${dailyRuns.runDate})` })
      .from(dailyRuns)
      .where(marketFilter);
    marketLastRunDate = row?.last ?? null;
  } catch (error) {
    console.warn("serpapi market-last-run lookup failed", error);
  }

  return {
    monthly_plan: plan.monthlyPlan,
    budget_pct: plan.budgetPct,
    renewal_day: plan.renewalDay,
    run_cap: plan.runCap,
    page_min_yield: plan.pageMinYield,
    max_pages: plan.maxPages,
    max_pages_cold: plan.maxPagesCold,
    cold_market_days: plan.coldMarketDays,
    adaptive_enabled: plan.adaptiveEnabled,
    adaptive_empty_runs: plan.adaptiveEmptyRuns,
    adaptive_interval_days: plan.adaptiveIntervalDays,
    /** CRM-side count for the worker's max(local, CRM) reconciliation. */
    month_to_date: monthToDate,
    period_start: serpapiPeriodStart(plan.renewalDay)
      .toISOString()
      .slice(0, 10),
    market_last_run_date: marketLastRunDate,
  };
}

export async function buildPipelineConfig() {
  const settings = await getOrCreateSettings();
  const stateGeoConfig = await getStateGeoConfigForState(settings.focusState);
  const profiles = await getActiveSearchProfiles();
  const zones = buildGeoZones(settings, stateGeoConfig);
  const googleZones = buildGoogleZones(
    { ...settings, stateGeoConfig },
    stateGeoConfig,
    zones,
  );

  const targetTitles = normalizeContactTitles(settings.contactTitles);
  const targetSeniorities = ["c_suite", "vp", "head", "director"];

  const searches = profiles.flatMap((p) =>
    zones.map((zone) => {
      const hoursOld = p.hoursOld ?? 168;
      const searchTerm = p.searchTerm.trim() ? p.searchTerm : " ";
      return {
        name: `${p.name} — ${zone.label}`,
        search_term: searchTerm,
        location: zone.location,
        zone_label: zone.label,
        google_search_term: googleSearchTerm(
          p.searchTerm,
          zone.location,
          hoursOld,
        ),
        country_indeed: "USA",
        is_remote: p.isRemote ?? false,
        results_wanted: p.resultsWanted ?? 50,
        hours_old: hoursOld,
        distance: p.linkedinDistance ?? 50,
        linkedin_distance: p.linkedinDistance ?? undefined,
      };
    }),
  );

  const marketLabel = activeMarketLabel({ ...settings, stateGeoConfig });

  return {
    settings: {
      geographic_scope: settings.geographicScope,
      focus_state: settings.focusState,
      focus_city: settings.focusCity,
      focus_county: settings.focusCounty,
      focus_cities: normalizeList(settings.focusCities),
      focus_counties: normalizeList(settings.focusCounties),
      metro_cities: normalizeList(settings.metroCities),
      metro_aliases: normalizeList(settings.metroAliases),
      state_geo_config: stateGeoConfig,
      notification_email: settings.notificationEmail,
      geo_label: zones.map((z) => z.label).join("; "),
      market_label: marketLabel,
      job_boards: resolveJobBoards(settings.jobBoards),
    },
    searches,
    boards: resolveJobBoards(settings.jobBoards),
    /** Zone collapse: Google/SerpApi queries only these zones per market. */
    board_zones: {
      google: googleZones.map((z) => z.label),
    },
    board_schedules: buildBoardSchedules(),
    serpapi: await serpapiConfigBlock(marketLabel),
    target_titles: targetTitles,
    target_seniorities: targetSeniorities,
    enrichment: {
      contacts_per_company: 3,
      target_titles: targetTitles,
      target_seniorities: targetSeniorities,
      enrich_phone: true,
      daily_credit_cap: 200,
      apollo_daily_credit_cap: Number.parseInt(
        process.env.APOLLO_DAILY_CREDIT_CAP ?? "200",
        10,
      ),
      contactout_daily_credit_cap: Number.parseInt(
        process.env.CONTACTOUT_DAILY_CREDIT_CAP ?? "50",
        10,
      ),
      paid_egress_enabled:
        process.env.PAID_EGRESS_ENABLED !== "false" &&
        process.env.APOLLO_EGRESS_ENABLED !== "false" &&
        process.env.APOLLO_PAID_EGRESS_ENABLED !== "false" &&
        process.env.CONTACTOUT_EGRESS_ENABLED !== "false" &&
        process.env.CONTACTOUT_PAID_EGRESS_ENABLED !== "false",
      scheduled_enrich_enabled: process.env.ENABLE_SCHEDULED_ENRICH === "true",
      daily_enrich_quota: settings.dailyEnrichQuota ?? 25,
      min_score_for_enrich: settings.minScoreForEnrich ?? 60,
      min_score_for_phone: settings.minScoreForPhone ?? 75,
      provider: "apollo",
    },
    dedupe: {
      company_domain: true,
      job_url: true,
    },
  };
}
