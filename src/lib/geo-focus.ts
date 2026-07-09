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

  // city scope (default)
  const cities = settings.focusCities?.length
    ? settings.focusCities
    : settings.focusCity
      ? [settings.focusCity]
      : ["West Palm Beach"];

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

export async function getGeoFocusSettings() {
  const { getOrCreateSettings } = await import("@/lib/pipeline-config");
  return getOrCreateSettings();
}
