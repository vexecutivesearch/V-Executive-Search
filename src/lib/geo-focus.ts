import { cache } from "react";
import { parseJobLocation } from "@/lib/location-match";
import {
  buildGeoZones,
  type GeoZone,
} from "@/lib/pipeline-config";
import type { pipelineSettings } from "@/lib/db/schema";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function cityMatches(jobCity: string, zoneCity: string): boolean {
  const job = normalize(jobCity);
  const zone = normalize(zoneCity);
  if (!job || !zone) return false;
  return job === zone || job.includes(zone) || zone.includes(job);
}

function stateMatches(
  jobStateAbbr: string | null,
  jobStateName: string | null,
  zoneState: string,
): boolean {
  const zone = normalize(zoneState);
  const abbr = (jobStateAbbr ?? "").toLowerCase();
  const name = (jobStateName ?? "").toLowerCase();
  if (zone.length === 2 && abbr === zone) return true;
  if (name && (name === zone || name.includes(zone) || zone.includes(name))) {
    return true;
  }
  return false;
}

/** WPB focus — LinkedIn lists jobs across Palm Beach + Broward counties. */
const PALM_BEACH_COUNTY_CITIES = [
  "west palm beach",
  "palm beach gardens",
  "boynton beach",
  "boca raton",
  "lake worth",
  "jupiter",
  "wellington",
  "delray beach",
  "royal palm beach",
  "greenacres",
  "lantana",
  "riviera beach",
  "palm springs",
  "north palm beach",
  "juno beach",
  "hypoluxo",
  "manalapan",
  "palm beach",
];

const BROWARD_COUNTY_CITIES = [
  "fort lauderdale",
  "hollywood",
  "pembroke pines",
  "miramar",
  "coral springs",
  "pompano beach",
  "davie",
  "sunrise",
  "plantation",
  "deerfield beach",
  "tamarac",
  "margate",
  "dania",
];

function isSouthFloridaMetroLocation(
  location: string,
  focusCities: string[],
): boolean {
  const focusPalmBeach = focusCities.some((city) => {
    const n = normalize(city);
    return n.includes("west palm") || n.includes("palm beach");
  });
  if (!focusPalmBeach) return false;
  const loc = normalize(location);
  return [...PALM_BEACH_COUNTY_CITIES, ...BROWARD_COUNTY_CITIES].some((city) =>
    loc.includes(city),
  );
}

/** True when a scraped job listing location falls inside admin geo focus. */
export function jobLocationInFocus(
  location: string | null | undefined,
  settings: typeof pipelineSettings.$inferSelect,
): boolean {
  if (!location?.trim()) return false;

  const parsed = parseJobLocation(location);
  if (!parsed) return false;

  const zones = buildGeoZones(settings);

  if (settings.geographicScope === "national") {
    return true;
  }

  if (settings.geographicScope === "state") {
    const state = settings.focusState || "Florida";
    return stateMatches(parsed.stateAbbr, parsed.stateName, state);
  }

  if (settings.geographicScope === "county") {
    const counties = settings.focusCounties?.length
      ? settings.focusCounties
      : settings.focusCounty
        ? [settings.focusCounty]
        : [];
    if (!counties.length) return true;
    const loc = normalize(location);
    return counties.some((county) => loc.includes(normalize(county)));
  }

  // city scope (default) — match focus cities + shared metro (e.g. Palm Beach County)
  const cities = settings.focusCities?.length
    ? settings.focusCities
    : settings.focusCity
      ? [settings.focusCity]
      : ["West Palm Beach"];

  const locNorm = normalize(location);

  if (
    cities.some((city) => normalize(city).includes("palm beach")) &&
    locNorm.includes("palm beach")
  ) {
    return true;
  }

  if (isSouthFloridaMetroLocation(location, cities)) {
    return true;
  }

  return cities.some((city) => {
    const zone = buildGeoZones({
      ...settings,
      geographicScope: "city",
      focusCities: [city],
    })[0];
    if (!parsed.city) return false;
    const zoneParsed = parseJobLocation(zone.location);
    if (!zoneParsed?.city) return cityMatches(parsed.city, city);
    const stateOk =
      !zoneParsed.stateAbbr ||
      !parsed.stateAbbr ||
      zoneParsed.stateAbbr === parsed.stateAbbr;
    return stateOk && cityMatches(parsed.city, zoneParsed.city);
  });
}

export function focusGeoLabel(
  settings: typeof pipelineSettings.$inferSelect,
): string {
  return buildGeoZones(settings)
    .map((z: GeoZone) => z.label)
    .join("; ");
}

export const getGeoFocusSettings = cache(async () => {
  const { getOrCreateSettings } = await import("@/lib/pipeline-config");
  return getOrCreateSettings();
});
