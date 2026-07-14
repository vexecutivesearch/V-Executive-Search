import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { pipelineSettings, searchProfiles } from "@/lib/db/schema";
import { TARGET_TITLES } from "@/lib/enrichment-config";
import { DEFAULT_JOB_BOARDS, resolveJobBoards } from "@/lib/job-boards";
import {
  DEFAULT_WPB_METRO_ALIASES,
  DEFAULT_WPB_METRO_CITIES,
} from "@/lib/metro-defaults";
import { backfillLinkedinDistanceDefaults } from "@/lib/search-profile-defaults";
import { SUGGESTED_FOCUS_KEYWORDS } from "@/lib/scrape-keyword-suggestions";

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

  if (!settings) {
    [settings] = await db
      .insert(pipelineSettings)
      .values({
        geographicScope: "city",
        focusState: "Florida",
        focusCity: "West Palm Beach",
        focusCities: ["West Palm Beach"],
        metroCities: [...DEFAULT_WPB_METRO_CITIES],
        metroAliases: [...DEFAULT_WPB_METRO_ALIASES],
        notificationEmail: "hello@proventheory.co",
        jobBoards: [...DEFAULT_JOB_BOARDS],
        contactTitles: [...TARGET_TITLES],
      })
      .returning();
  } else if (!normalizeList(settings.metroCities).length) {
    [settings] = await db
      .update(pipelineSettings)
      .set({
        metroCities: [...DEFAULT_WPB_METRO_CITIES],
        metroAliases: [...DEFAULT_WPB_METRO_ALIASES],
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
  settings: Awaited<ReturnType<typeof getOrCreateSettings>>,
): GeoZone[] {
  const state = settings.focusState || "Florida";
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
      const loc = formatBoardLocation(`${county} County`, state);
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
  const focusList = focus.length
    ? focus
    : legacyCity
      ? [legacyCity]
      : metro.length
        ? [metro[0]]
        : ["West Palm Beach"];
  const ordered: string[] = [];
  for (const city of [...focusList, ...metro]) {
    const key = city.trim().toLowerCase();
    if (!key) continue;
    if (ordered.some((c) => c.toLowerCase() === key)) continue;
    ordered.push(city.trim());
  }
  const list = ordered.slice(0, MAX_SCRAPE_CITY_ZONES);

  for (const city of list) {
    const loc = formatBoardLocation(city, state);
    zones.push({
      label: loc,
      location: loc,
      googleSuffix: loc,
    });
  }

  return zones;
}

/** USPS-style place for JobSpy / Google NL ("West Palm Beach, FL"). */
const STATE_ABBR: Record<string, string> = {
  Florida: "FL",
  florida: "FL",
  FL: "FL",
  fl: "FL",
};

export function formatBoardLocation(cityOrPlace: string, state: string): string {
  const place = cityOrPlace.trim().replace(/,?\s*(FL|Florida)\s*$/i, "");
  const abbr =
    STATE_ABBR[state.trim()] ??
    (state.trim().length === 2 ? state.trim().toUpperCase() : state.trim());
  if (!place) return abbr;
  // Already "City, ST"
  if (/,\s*[A-Z]{2}$/i.test(place)) return place;
  return `${place}, ${abbr}`;
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

export async function buildPipelineConfig() {
  const settings = await getOrCreateSettings();
  const profiles = await getActiveSearchProfiles();
  const zones = buildGeoZones(settings);

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
      notification_email: settings.notificationEmail,
      geo_label: zones.map((z) => z.label).join("; "),
      job_boards: resolveJobBoards(settings.jobBoards),
    },
    searches,
    boards: resolveJobBoards(settings.jobBoards),
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
