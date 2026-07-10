import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { pipelineSettings, searchProfiles } from "@/lib/db/schema";
import { DEFAULT_JOB_BOARDS, resolveJobBoards } from "@/lib/job-boards";
import {
  DEFAULT_WPB_METRO_ALIASES,
  DEFAULT_WPB_METRO_CITIES,
} from "@/lib/metro-defaults";

const DEFAULT_SEARCHES = [
  { name: "HR Director", searchTerm: "HR Director", sortOrder: 0 },
  { name: "VP People", searchTerm: "VP People", sortOrder: 1 },
  { name: "Head of Talent", searchTerm: "Head of Talent", sortOrder: 2 },
];

export type GeoZone = {
  label: string;
  location: string;
  googleSuffix: string;
};

function normalizeList(values: string[] | null | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
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
    const key = row.searchTerm.trim().toLowerCase();
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

  const existingProfiles = await db.select().from(searchProfiles).limit(1);
  if (!existingProfiles.length) {
    await db.insert(searchProfiles).values(
      DEFAULT_SEARCHES.map((s) => ({
        name: s.name,
        searchTerm: s.searchTerm,
        isActive: true,
        sortOrder: s.sortOrder,
      })),
    );
    await dedupeSearchProfiles();
  }

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
export function buildGeoZones(settings: typeof pipelineSettings.$inferSelect): GeoZone[] {
  const state = settings.focusState || "Florida";
  const zones: GeoZone[] = [];

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
      zones.push({
        label: `${county} County, ${state}`,
        location: `${county} County, ${state}`,
        googleSuffix: `${county} County ${state}`,
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

  // city scope (default)
  const cities = normalizeList(settings.focusCities);
  const legacyCity = settings.focusCity?.trim();
  const list = cities.length ? cities : legacyCity ? [legacyCity] : ["West Palm Beach"];

  for (const city of list) {
    zones.push({
      label: `${city}, ${state}`,
      location: `${city}, ${state}`,
      googleSuffix: `${city} ${state}`,
    });
  }

  return zones;
}

export async function buildPipelineConfig() {
  const settings = await getOrCreateSettings();
  const profiles = await getActiveSearchProfiles();
  const zones = buildGeoZones(settings);

  const targetTitles = [
    "CEO",
    "Chief Executive Officer",
    "President",
    "Founder",
    "Co-Founder",
    "COO",
    "Chief Operating Officer",
    "CFO",
    "Chief Financial Officer",
    "CTO",
    "Chief Technology Officer",
    "CHRO",
    "Chief People Officer",
    "VP People",
    "VP Human Resources",
    "Head of HR",
    "HR Director",
    "Director of Human Resources",
  ];

  const targetSeniorities = ["c_suite", "vp", "head", "director"];

  const searches = profiles.flatMap((p) =>
    zones.map((zone) => ({
      name: `${p.name} — ${zone.label}`,
      search_term: p.searchTerm,
      location: zone.location,
      google_search_term: `${p.searchTerm} jobs ${zone.googleSuffix} since yesterday`,
      country_indeed: "USA",
      is_remote: p.isRemote ?? false,
      results_wanted: p.resultsWanted ?? 50,
      hours_old: p.hoursOld ?? 24,
    })),
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
