/**
 * The Pipeline page speaks three location vocabularies. They are reconciled
 * here, and only here, so the controls on screen can never silently disagree
 * about what is scoped to what.
 *
 * 1. Browse scope — the State → City pair in the filter bar, summarised by the
 *    location rail. Narrows companies already in the database by job-listing
 *    geography (falling back to the company's own HQ when it has no listings).
 *    Applies to All leads, Job listings and Hot.
 *
 * 2. Review scope — the Discovery review queue. Narrows by the market a
 *    company was FOUND IN (companies.source_market), which is the label the
 *    row itself carries. Browse scope deliberately does not apply here: a
 *    company-first Apollo row can have no job listings at all, so job-listing
 *    geography would hide it while the queue counts still counted it.
 *
 * 3. Discovery market — the run launcher's "Apollo market to search". A search
 *    input, not a filter: it decides where to go looking for companies that are
 *    not in the database yet, so its curated list stays whole.
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

/* ------------------------------------------------------------------ */
/* Review scope — vocabulary 2                                         */
/* ------------------------------------------------------------------ */

/**
 * Hiring is a signal, never a requirement — but the queue is ordered by lead
 * score, and any hiring bonus pushes companies with open roles to the front.
 * This lets the operator look at the non-hiring companies directly instead of
 * paging past everything that happens to be advertising a job.
 */
export type HiringFilter = "any" | "hiring" | "no_hiring";

export function parseHiringFilter(value: unknown): HiringFilter {
  return value === "hiring" || value === "no_hiring" ? value : "any";
}

export type ReviewScope = {
  /** Discovery vertical id — "" for every vertical. */
  vertical: string;
  /** Market the row was found in (source_market) — "" for every market. */
  market: string;
  /** Free text over company name / domain / industry. */
  search: string;
  /** Job-signal filter — "any" imposes no predicate. */
  hiring: HiringFilter;
};

export type ReviewScopeOptions = {
  verticals: readonly string[];
  markets: readonly string[];
};

export const EMPTY_REVIEW_SCOPE: ReviewScope = {
  vertical: "",
  market: "",
  search: "",
  hiring: "any",
};

/**
 * A vertical or market that is no longer in the facets has no chip on screen,
 * so a stale value carried in from a bookmark would empty the queue with
 * nothing visible to blame or clear. Unknown values are dropped instead.
 */
export function normalizeReviewScope(
  raw: {
    vertical?: string | null;
    dmarket?: string | null;
    q?: string | null;
    hiring?: string | null;
  },
  options: ReviewScopeOptions,
): ReviewScope {
  const vertical = (raw.vertical ?? "").trim();
  const market = (raw.dmarket ?? "").trim();
  return {
    vertical: options.verticals.includes(vertical) ? vertical : "",
    market: options.markets.includes(market) ? market : "",
    search: (raw.q ?? "").trim(),
    hiring: parseHiringFilter(raw.hiring),
  };
}

export type ActiveReviewFilter = {
  /** Query-string key, so a caller can clear exactly this one. */
  key: "vertical" | "dmarket" | "q" | "hiring";
  value: string;
};

/** Filters currently narrowing the queue, for "N hidden by filters" copy. */
export function activeReviewFilters(scope: ReviewScope): ActiveReviewFilter[] {
  const active: ActiveReviewFilter[] = [];
  if (scope.vertical) active.push({ key: "vertical", value: scope.vertical });
  if (scope.market) active.push({ key: "dmarket", value: scope.market });
  if (scope.search) active.push({ key: "q", value: scope.search });
  // The job-signal chips narrow the queue exactly as the others do, so they
  // have to be named in the filtered-to line and cleared by the same link.
  // Otherwise "No job postings" over an empty bucket reads as "the discovery
  // run found nothing", which is the confusion this whole rework removes.
  if (scope.hiring !== "any") {
    active.push({ key: "hiring", value: scope.hiring });
  }
  return active;
}

/**
 * Filters handed to the review-queue read.
 *
 * Deliberately carries no state/city. The queue and its per-bucket counts are
 * built from exactly this set, which is why a count can no longer promise rows
 * the list then filters away.
 */
export function reviewQueueQueryFilters<Status extends string>(
  scope: ReviewScope,
  extras: { reviewStatus: Status; page: number },
): {
  reviewStatus: Status;
  vertical: string | undefined;
  market: string | undefined;
  search: string | undefined;
  hiring: HiringFilter;
  page: number;
} {
  return {
    reviewStatus: extras.reviewStatus,
    vertical: scope.vertical || undefined,
    market: scope.market || undefined,
    search: scope.search || undefined,
    hiring: scope.hiring,
    page: extras.page,
  };
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
