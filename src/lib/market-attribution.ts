/**
 * Market provenance for the consolidated CRM view.
 *
 * A "market" is a metro preset from the state geo configs (e.g. "Charlotte, NC"
 * spans Rock Hill, SC). Companies scraped going forward are tagged at ingest
 * with the market active in Admin (companies.source_market); historical rows
 * are derived from their job listing locations against the market registry so
 * cross-state metros stay intact — never a bare state filter.
 */

import { parseJobLocation } from "@/lib/location-match";
import type { StateGeoConfig, StateGeoMetroPreset } from "@/lib/state-geo-config";
import { getStateGeoConfig } from "@/lib/state-geo-config";
import type { GeoFocusSettings } from "@/lib/geo-focus";

export const UNKNOWN_MARKET_LABEL = "No market match";
/** URL/select token for the unmatched bucket — always visible, never dropped. */
export const UNKNOWN_MARKET_VALUE = "location_unknown";

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Split "Rock Hill, SC" → { city: "Rock Hill", stateAbbr: "SC" }. */
function splitCityToken(token: string): { city: string; stateAbbr: string | null } {
  const match = token.trim().match(/^(.*?),\s*([A-Za-z]{2})$/);
  if (match) return { city: match[1].trim(), stateAbbr: match[2].toUpperCase() };
  return { city: token.trim(), stateAbbr: null };
}

export function marketLabelForPreset(
  presetKey: string,
  preset: Pick<StateGeoMetroPreset, "marketName">,
  stateAbbr: string,
): string {
  const name = preset.marketName?.trim() || titleCase(presetKey);
  return `${name}, ${stateAbbr.toUpperCase()}`;
}

export type MarketIndex = {
  /** "city|ST" → market label (first registered market wins). */
  byCityState: Map<string, string>;
  /** city → market label, or null when the city is ambiguous across markets. */
  byCityOnly: Map<string, string | null>;
  /** Normalized metro alias substrings → market label. */
  aliases: Array<{ alias: string; label: string }>;
  /** market label → member cities (for SQL prefilters). */
  citiesByLabel: Map<string, Array<{ city: string; stateAbbr: string }>>;
  /** market label → normalized alias substrings. */
  aliasesByLabel: Map<string, string[]>;
  /** All registered market labels, in registry order. */
  labels: string[];
};

/** Build a lookup from the market registry (all states, all metro presets). */
export function buildMarketIndex(configs: StateGeoConfig[]): MarketIndex {
  const byCityState = new Map<string, string>();
  const byCityOnly = new Map<string, string | null>();
  const aliases: Array<{ alias: string; label: string }> = [];
  const citiesByLabel = new Map<string, Array<{ city: string; stateAbbr: string }>>();
  const aliasesByLabel = new Map<string, string[]>();
  const labels: string[] = [];

  for (const config of configs) {
    for (const [key, preset] of Object.entries(config.metroPresets ?? {})) {
      const label = marketLabelForPreset(key, preset, config.stateAbbr);
      if (!labels.includes(label)) labels.push(label);
      const memberCities = citiesByLabel.get(label) ?? [];
      const memberAliases = aliasesByLabel.get(label) ?? [];

      for (const cityToken of preset.metroCities ?? []) {
        const { city, stateAbbr } = splitCityToken(cityToken);
        const cityKey = norm(city);
        if (!cityKey) continue;
        const state = (stateAbbr ?? config.stateAbbr).toUpperCase();
        const fullKey = `${cityKey}|${state}`;
        if (!byCityState.has(fullKey)) byCityState.set(fullKey, label);
        if (!memberCities.some((c) => c.city === city && c.stateAbbr === state)) {
          memberCities.push({ city, stateAbbr: state });
        }

        if (!byCityOnly.has(cityKey)) {
          byCityOnly.set(cityKey, label);
        } else if (byCityOnly.get(cityKey) !== label) {
          byCityOnly.set(cityKey, null);
        }
      }

      for (const alias of preset.metroAliases ?? []) {
        const aliasKey = norm(alias);
        if (aliasKey) {
          aliases.push({ alias: aliasKey, label });
          if (!memberAliases.includes(aliasKey)) memberAliases.push(aliasKey);
        }
      }

      citiesByLabel.set(label, memberCities);
      aliasesByLabel.set(label, memberAliases);
    }
  }

  return { byCityState, byCityOnly, aliases, citiesByLabel, aliasesByLabel, labels };
}

/** Market for one scraped job location, or null when nothing matches. */
export function marketForJobLocation(
  location: string | null | undefined,
  index: MarketIndex,
): string | null {
  if (!location?.trim()) return null;

  const parsed = parseJobLocation(location);
  if (parsed?.city) {
    const cityKey = norm(parsed.city);
    if (parsed.stateAbbr) {
      const exact = index.byCityState.get(`${cityKey}|${parsed.stateAbbr}`);
      if (exact) return exact;
    } else {
      const unambiguous = index.byCityOnly.get(cityKey);
      if (unambiguous) return unambiguous;
    }
  }

  const loc = norm(location);
  for (const { alias, label } of index.aliases) {
    if (loc.includes(alias)) return label;
  }
  return null;
}

/** Derive a company's market from its job locations — most frequent match wins. */
export function deriveMarketFromListings(
  listings: Array<{ location: string | null }>,
  index: MarketIndex,
): string | null {
  const counts = new Map<string, number>();
  for (const listing of listings) {
    const label = marketForJobLocation(listing.location, index);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

function listEqualsNormalized(a: string[], b: string[]): boolean {
  const setA = new Set(a.map(norm).filter(Boolean));
  const setB = new Set(b.map(norm).filter(Boolean));
  if (setA.size !== setB.size) return false;
  for (const value of setA) if (!setB.has(value)) return false;
  return true;
}

/**
 * Label of the market currently active in Admin — used to stamp
 * companies.source_market at ingest time.
 */
export function activeMarketLabel(settings: GeoFocusSettings): string | null {
  if (settings.geographicScope === "national") return null;

  const config = settings.stateGeoConfig ?? getStateGeoConfig(settings.focusState);

  if (settings.geographicScope === "state") {
    const state = settings.focusState?.trim();
    return state ? `${state} (statewide)` : null;
  }

  const metroCities = settings.metroCities ?? [];
  const focusCounties = settings.focusCounties ?? [];

  // Exact preset match (same rule the Admin UI uses to show the active market).
  for (const [key, preset] of Object.entries(config.metroPresets ?? {})) {
    if (
      listEqualsNormalized(metroCities, preset.metroCities ?? []) &&
      listEqualsNormalized(focusCounties, preset.focusCounties ?? [])
    ) {
      return marketLabelForPreset(key, preset, config.stateAbbr);
    }
  }

  // Looser match on metro city set only (counties tweaked by hand).
  for (const [key, preset] of Object.entries(config.metroPresets ?? {})) {
    if (listEqualsNormalized(metroCities, preset.metroCities ?? [])) {
      return marketLabelForPreset(key, preset, config.stateAbbr);
    }
  }

  const primaryCity =
    settings.focusCities?.[0]?.trim() || settings.focusCity?.trim() || null;
  if (primaryCity) {
    const { city, stateAbbr } = splitCityToken(primaryCity);
    return `${city}, ${(stateAbbr ?? config.stateAbbr).toUpperCase()}`;
  }
  return null;
}
