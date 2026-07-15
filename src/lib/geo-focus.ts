import { cache } from "react";
import { countyInFocus } from "@/lib/county-map";
import {
  normalizeJobLocationString,
  parseJobLocation,
} from "@/lib/location-match";
import { normalizeMetroToken } from "@/lib/metro-defaults";
import { buildGeoZones, type GeoZone } from "@/lib/pipeline-config";
import type { pipelineSettings } from "@/lib/db/schema";
import {
  getStateGeoConfig,
  resolveCountyForCity,
  type StateGeoConfig,
} from "@/lib/state-geo-config";

export type GeoMatchResult = "in_metro" | "out_of_metro" | "location_unknown";
export type GeoFocusSettings = typeof pipelineSettings.$inferSelect & {
  stateGeoConfig?: StateGeoConfig | null;
};

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

function stateGeoConfigForSettings(settings: GeoFocusSettings): StateGeoConfig {
  return settings.stateGeoConfig ?? getStateGeoConfig(settings.focusState);
}

/** Metro cities from admin config; falls back to active state's defaults when unset. */
export function getMetroCities(settings: GeoFocusSettings): string[] {
  const configured = normalizeList(settings.metroCities);
  if (configured.length) return configured;
  return [...stateGeoConfigForSettings(settings).defaultMetroCities];
}

export function getMetroAliases(settings: GeoFocusSettings): string[] {
  const configured = normalizeList(settings.metroAliases);
  if (configured.length) return configured;
  return [...stateGeoConfigForSettings(settings).defaultMetroAliases];
}

/** Accepted counties for metro geo — config-driven per active state. */
export function getAcceptedCounties(settings: GeoFocusSettings): string[] {
  const configured = normalizeList(settings.focusCounties);
  if (configured.length) return configured;

  const legacy = settings.focusCounty?.trim();
  if (legacy) return [legacy];

  return [...stateGeoConfigForSettings(settings).defaultFocusCounties];
}

function countyFromLocationString(
  location: string,
  config: StateGeoConfig,
): string | null {
  const loc = normalize(location);
  if (!loc) return null;
  for (const county of config.counties) {
    const countyToken = normalize(county);
    if (loc.includes(`${countyToken} county`) || loc.includes(countyToken)) {
      return county;
    }
  }
  return null;
}

function resolveConfiguredCounty(
  parsed: NonNullable<ReturnType<typeof parseJobLocation>>,
  location: string,
  config: StateGeoConfig,
): string[] {
  const fromString = countyFromLocationString(location, config);
  if (fromString) return [fromString];
  return resolveCountyForCity(config, parsed.city);
}

function matchesCountyFocus(
  location: string,
  parsed: NonNullable<ReturnType<typeof parseJobLocation>>,
  settings: GeoFocusSettings,
): boolean | null {
  const accepted = getAcceptedCounties(settings);
  if (!accepted.length) return null;
  const config = stateGeoConfigForSettings(settings);

  const counties = resolveConfiguredCounty(parsed, location, config);
  if (!counties.length) return null;
  return counties.some((county) => countyInFocus(county, accepted));
}

/** True when county-based geo is active for this market. */
export function isCountyGeoActive(settings: GeoFocusSettings): boolean {
  return getAcceptedCounties(settings).length > 0;
}

function matchesMetroCityOrAlias(
  location: string,
  settings: GeoFocusSettings,
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
  settings: GeoFocusSettings,
): GeoMatchResult {
  if (!location?.trim()) return "location_unknown";

  const normalized = normalizeJobLocationString(location);
  const parsed = parseJobLocation(normalized);
  if (!parsed) return "location_unknown";

  const countyMatch = matchesCountyFocus(normalized, parsed, settings);
  if (countyMatch === true) return "in_metro";
  if (countyMatch === false) return "out_of_metro";

  if (matchesMetroCityOrAlias(normalized, settings)) return "in_metro";

  // County geo active but city not in map — review bucket, not legacy pass/reject.
  if (isCountyGeoActive(settings)) return "location_unknown";

  if (jobLocationInFocus(normalized, settings)) return "in_metro";
  return "out_of_metro";
}

/** True when a scraped job listing location falls inside admin geo focus. */
export function jobLocationInFocus(
  location: string | null | undefined,
  settings: GeoFocusSettings,
): boolean {
  if (!location?.trim()) return false;

  const normalized = normalizeJobLocationString(location);
  const parsed = parseJobLocation(normalized);
  if (!parsed) return false;

  const config = stateGeoConfigForSettings(settings);

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
    if (counties.some((county) => loc.includes(normalize(county)))) return true;
    const countyMatch = matchesCountyFocus(normalized, parsed, settings);
    if (countyMatch === true) return true;
    if (countyMatch === false) return false;
    return false;
  }

  // city scope (default) — county map when configured; legacy city list only without county geo
  const countyMatch = matchesCountyFocus(normalized, parsed, settings);
  if (countyMatch === true) return true;
  if (countyMatch === false) return false;

  if (matchesMetroCityOrAlias(normalized, settings)) return true;

  if (isCountyGeoActive(settings)) return false;

  const cities = settings.focusCities?.length
    ? settings.focusCities
    : settings.focusCity
      ? [settings.focusCity]
      : config.defaultFocusCities;

  return cities.some((city) => {
    const zone = buildGeoZones({
      ...settings,
      geographicScope: "city",
      focusCities: [city],
    }, config)[0];
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
  settings: GeoFocusSettings,
): string {
  const config = stateGeoConfigForSettings(settings);
  const zones = buildGeoZones(settings, config)
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
  const { getStateGeoConfigForState } = await import(
    "@/lib/state-geo-config-store"
  );
  const settings = await getOrCreateSettings();
  return {
    ...settings,
    stateGeoConfig: await getStateGeoConfigForState(settings.focusState),
  };
});
