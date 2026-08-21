/**
 * The Pipeline page speaks two location vocabularies:
 *
 * - Browse scope (location rail + filter bar) narrows rows already in the
 *   database. It is state-led: State → City.
 * - Discovery market is an Apollo search target — where to go find companies
 *   that are not in the database yet. Its list is curated to metros/counties
 *   Apollo can actually search.
 *
 * They are reconciled here, and only here, so the controls on screen can never
 * silently disagree about what is scoped to what.
 */

import { parseJobLocation } from "@/lib/location-match";

export type CityOption = { city: string; stateAbbr: string };

export type LocationScope = { state: string; city: string };

export type LocationScopeOptions = {
  states: readonly string[];
  cities: readonly CityOption[];
};

/** Rendering every parsed city of a large state would blow up the select. */
export const CITY_OPTION_LIMIT = 400;

export const EMPTY_LOCATION_SCOPE: LocationScope = { state: "", city: "" };

/**
 * The server-side city predicate matches on city name alone, so a `city` with
 * no `state` quietly pulls in same-named cities from every other state, and a
 * `city` left over from a different state contradicts the state scope. Both
 * combinations are dropped rather than rendered as an impossible selection.
 *
 * Idempotent: normalizing an already-normalized scope is a no-op.
 */
export function normalizeLocationScope(
  raw: { state?: string | null; city?: string | null },
  options: LocationScopeOptions,
): LocationScope {
  const state = (raw.state ?? "").trim().toUpperCase();
  if (!state || !options.states.includes(state)) return EMPTY_LOCATION_SCOPE;

  const city = (raw.city ?? "").trim().toLowerCase();
  if (!city) return { state, city: "" };

  const match = options.cities.find(
    (c) => c.stateAbbr === state && c.city.toLowerCase() === city,
  );
  return { state, city: match?.city ?? "" };
}

/** Cities the current state scope allows — empty until a state is chosen. */
export function cityOptionsForState(
  cities: readonly CityOption[],
  state: string,
): CityOption[] {
  if (!state) return [];
  return cities.filter((c) => c.stateAbbr === state).slice(0, CITY_OPTION_LIMIT);
}

export function stateLabel(state: string): string {
  return (state && parseJobLocation(state)?.stateName) || state;
}

/**
 * Suggest an Apollo market from the browse scope: browsing Florida should not
 * leave the run launcher pointed at whatever market happens to be first.
 *
 * A suggestion only — the curated list stays whole, because searching Dallas
 * while browsing Florida is a legitimate thing to do.
 */
export function defaultDiscoveryMarket(
  markets: readonly string[],
  scope: { state?: string | null; city?: string | null },
): string | null {
  const state = (scope.state ?? "").trim().toUpperCase();
  if (!state) return null;
  const city = (scope.city ?? "").trim().toLowerCase();

  let stateMatch: string | null = null;
  for (const market of markets) {
    const parsed = parseJobLocation(market);
    if (!parsed || parsed.stateAbbr !== state) continue;
    if (city && parsed.city?.toLowerCase() === city) return market;
    if (!stateMatch) stateMatch = market;
  }
  return stateMatch;
}
