import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  pipelineSettings,
  searchProfiles,
  GeographicScope,
} from "@/lib/db/schema";

const DEFAULT_SEARCHES = [
  { name: "HR Director", searchTerm: "HR Director", sortOrder: 0 },
  { name: "VP People", searchTerm: "VP People", sortOrder: 1 },
  { name: "Head of Talent", searchTerm: "Head of Talent", sortOrder: 2 },
];

export async function getOrCreateSettings() {
  const rows = await db.select().from(pipelineSettings).limit(1);
  if (rows.length > 0) return rows[0];

  const [created] = await db
    .insert(pipelineSettings)
    .values({
      geographicScope: "state",
      focusState: "Florida",
      notificationEmail: "hello@proventheory.co",
    })
    .returning();

  for (const s of DEFAULT_SEARCHES) {
    await db.insert(searchProfiles).values(s);
  }

  return created;
}

export function buildJobSpyLocation(settings: {
  geographicScope: GeographicScope;
  focusState: string | null;
  focusCity: string | null;
  focusCounty: string | null;
}): { location: string; googleSuffix: string; label: string } {
  const state = settings.focusState?.trim() || "Florida";

  switch (settings.geographicScope) {
    case "national":
      return {
        location: "United States",
        googleSuffix: "United States",
        label: "United States (national)",
      };
    case "city": {
      const city = settings.focusCity?.trim();
      if (!city) {
        return { location: state, googleSuffix: state, label: state };
      }
      const loc = city.includes(",") ? city : `${city}, ${state}`;
      return { location: loc, googleSuffix: loc, label: loc };
    }
    case "county": {
      const county = settings.focusCounty?.trim();
      if (!county) {
        return { location: state, googleSuffix: state, label: state };
      }
      const countyLoc = county.toLowerCase().includes("county")
        ? `${county}, ${state}`
        : `${county} County, ${state}`;
      return { location: countyLoc, googleSuffix: countyLoc, label: countyLoc };
    }
    case "state":
    default:
      return {
        location: state,
        googleSuffix: state,
        label: state,
      };
  }
}

export async function buildPipelineConfig() {
  const settings = await getOrCreateSettings();
  const profiles = await db
    .select()
    .from(searchProfiles)
    .where(eq(searchProfiles.isActive, true))
    .orderBy(searchProfiles.sortOrder);

  const geo = buildJobSpyLocation(settings);

  const searches = profiles.map((p) => ({
    name: `${p.searchTerm} — ${geo.label}`,
    search_term: p.searchTerm,
    location: geo.location,
    google_search_term: `${p.searchTerm} jobs ${geo.googleSuffix} since yesterday`,
    country_indeed: "USA",
    is_remote: p.isRemote ?? undefined,
    results_wanted: p.resultsWanted ?? 50,
    hours_old: p.hoursOld ?? 24,
  }));

  return {
    settings: {
      geographic_scope: settings.geographicScope,
      focus_state: settings.focusState,
      focus_city: settings.focusCity,
      focus_county: settings.focusCounty,
      notification_email: settings.notificationEmail,
      run_requested_at: settings.runRequestedAt?.toISOString() ?? null,
      geo_label: geo.label,
    },
    searches,
    boards: ["indeed", "google", "zip_recruiter"],
    target_titles: [
      "CEO",
      "Founder",
      "Owner",
      "President",
      "HR Manager",
      "Head of Talent",
      "VP People",
      "Chief People Officer",
      "Director of HR",
      "Human Resources Manager",
    ],
    target_seniorities: ["c_suite", "vp", "head", "director", "manager"],
    enrichment: {
      contacts_per_company: 2,
      enrich_phone: true,
      daily_credit_cap: 200,
      provider: "apollo",
    },
  };
}
