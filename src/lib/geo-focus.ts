import { cache } from "react";
import {
  normalizeJobLocationString,
  parseJobLocation,
} from "@/lib/location-match";
import {
  DEFAULT_WPB_METRO_ALIASES,
  DEFAULT_WPB_METRO_CITIES,
  normalizeMetroToken,
} from "@/lib/metro-defaults";
import { buildGeoZones, type GeoZone } from "@/lib/pipeline-config";
import type { pipelineSettings } from "@/lib/db/schema";

export type GeoMatchResult = "in_metro" | "out_of_metro" | "location_unknown";

function normalize(value: string): string {
  return normalizeMetroToken(value);
}

function normalizeList(values: string[] | null | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
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

function focusUsesWpbMetro(focusCities: string[]): boolean {
  return focusCities.some((city) => {
    const n = normalize(city);
    return n.includes("west palm") || n.includes("palm beach");
  });
}

/** Metro cities from admin config; falls back to WPB defaults when unset. */
export function getMetroCities(
  settings: typeof pipelineSettings.$inferSelect,
): string[] {
  const configured = normalizeList(settings.metroCities);
  if (configured.length) return configured;

  const focus = normalizeList(
    settings.focusCities?.length
      ? settings.focusCities
      : settings.focusCity
        ? [settings.focusCity]
        : ["West Palm Beach"],
  );
  if (focusUsesWpbMetro(focus)) {
    return [...DEFAULT_WPB_METRO_CITIES];
  }
  return [];
}

export function getMetroAliases(
  settings: typeof pipelineSettings.$inferSelect,
): string[] {
  const configured = normalizeList(settings.metroAliases);
  if (configured.length) return configured;
  return [...DEFAULT_WPB_METRO_ALIASES];
}

function matchesMetroCityOrAlias(
  location: string,
  settings: typeof pipelineSettings.$inferSelect,
): boolean {
  const loc = normalize(normalizeJobLocationString(location));
  if (!loc) return false;

  for (const alias of getMetroAliases(settings)) {
    if (loc.includes(normalize(alias))) return true;
  }

  const metroCities = getMetroCities(settings);
  return metroCities.some((city) => loc.includes(normalize(city)));
}

/** Classify a scraped job location — never silently drop; unknown ≠ out-of-metro. */
export function classifyJobLocation(
  location: string | null | undefined,
  settings: typeof pipelineSettings.$inferSelect,
): GeoMatchResult {
  if (!location?.trim()) return "location_unknown";

  const normalized = normalizeJobLocationString(location);
  const parsed = parseJobLocation(normalized);
  if (!parsed) return "location_unknown";

  if (jobLocationInFocus(normalized, settings)) return "in_metro";
  return "out_of_metro";
}

/** True when a scraped job listing location falls inside admin geo focus. */
export function jobLocationInFocus(
  location: string | null | undefined,
  settings: typeof pipelineSettings.$inferSelect,
): boolean {
  if (!location?.trim()) return false;

  const normalized = normalizeJobLocationString(location);
  const parsed = parseJobLocation(normalized);
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
    const loc = normalize(normalized);
    return counties.some((county) => loc.includes(normalize(county)));
  }

  // city scope (default) — focus cities + configured metro expansion
  const cities = settings.focusCities?.length
    ? settings.focusCities
    : settings.focusCity
      ? [settings.focusCity]
      : ["West Palm Beach"];

  if (matchesMetroCityOrAlias(normalized, settings)) {
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
  const zones = buildGeoZones(settings)
    .map((z: GeoZone) => z.label)
    .join("; ");
  const metro = getMetroCities(settings);
  if (metro.length > 6) {
    return `${zones} + ${metro.length} metro cities`;
  }
  if (metro.length) {
    return `${zones} + metro (${metro.slice(0, 4).join(", ")}…)`;
  }
  return zones;
}

export const getGeoFocusSettings = cache(async () => {
  const { getOrCreateSettings } = await import("@/lib/pipeline-config");
  return getOrCreateSettings();
});
