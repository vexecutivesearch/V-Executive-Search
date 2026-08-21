/**
 * Company discovery, provider-agnostic.
 *
 * Discovery started as one Apollo organization-search call and the whole
 * downstream pipeline is shaped like Apollo's response. That was fine while
 * Apollo was the only source; it stops being fine the moment a second one
 * exists, because Apollo and SerpApi disagree about almost everything that
 * matters — Apollo bills per page of up to 100 records and knows headcount,
 * SerpApi bills per search of exactly 20 records and never knows headcount but
 * does know the main line for the small local firms Apollo has no row for.
 *
 * Everything provider-specific therefore lives behind `CompanyDiscoverySource`:
 * a source takes (vertical, market, limit) and returns organizations already
 * normalised into the `DiscoveredOrganization` shape `run.ts` consumes, so
 * dedupe, ICP annotation, scoring and the review queue never learn a second
 * vocabulary. Adding a third source is a new file plus a registry entry.
 *
 * Maps turns on from `SERPAPI_API_KEY`, same as the worker's Google Jobs
 * scrape. `SERPAPI_DISCOVERY_ENABLED=false` is the kill switch. A missing
 * key stays inert — the CRM cannot see the worker's copy.
 */

import type { DiscoveredOrganization } from "@/lib/domain-resolver";
import type { PaidEgressContext } from "@/lib/paid-egress";

export type DiscoverySourceRequest = {
  vertical: string;
  /** Market string for THIS run, e.g. "Palm Beach County, Florida". */
  market: string;
  /** Companies wanted from this source in this run. Advisory, never a promise. */
  limit: number;
  context?: PaidEgressContext;
};

/**
 * Why a candidate never reached the operator, keyed by reason so the run
 * summary can say "14 staffing agencies, 3 out of market" rather than a bare
 * count. Reasons are free-form strings owned by each source.
 */
export type DiscoveryRejectionCounts = Record<string, number>;

export type DiscoverySourceOutcome = {
  /** Already normalised — `run.ts` treats these exactly like Apollo rows. */
  organizations: DiscoveredOrganization[];
  /**
   * Provider-native billable units this call consumed: Apollo credits,
   * SerpApi searches. Deliberately NOT normalised to a common currency — the
   * operator's caps are per provider and a fake common unit would hide which
   * budget was actually spent.
   */
  unitsSpent: number;
  /** Filtered out before insert (staffing agency, out of market, …). */
  rejected: DiscoveryRejectionCounts;
  /** True when this source has nothing left for (vertical, market). */
  poolExhausted: boolean;
  /** Operator-facing lines appended to the run summary. */
  notes: string[];
};

export const EMPTY_OUTCOME: DiscoverySourceOutcome = {
  organizations: [],
  unitsSpent: 0,
  rejected: {},
  poolExhausted: false,
  notes: [],
};

export interface CompanyDiscoverySource {
  /** Stable id for logs, usage events and the run summary. */
  readonly name: string;
  /** What `unitsSpent` counts, for the operator-facing cost note. */
  readonly billingUnit: "credit" | "search";
  /**
   * Some sources only make sense for some verticals — Google Maps is excellent
   * for roofing and useless for "operations consulting" — so a source declines
   * rather than being asked to return noise it will bill for.
   */
  supportsVertical(vertical: string): boolean;
  discover(request: DiscoverySourceRequest): Promise<DiscoverySourceOutcome>;
}

export type DiscoverySourceEnv = Record<string, string | undefined>;

export type DiscoverySourceResolution =
  | { enabled: true; source: CompanyDiscoverySource }
  | { enabled: false; reason: string };

export function sourceFlagOn(
  flag: string,
  env: DiscoverySourceEnv = process.env,
): boolean {
  return ["1", "true", "yes", "on"].includes(
    (env[flag] ?? "").trim().toLowerCase(),
  );
}

/** Explicit off. An unset flag is not off — Maps turns on from the API key. */
export function sourceFlagOff(
  flag: string,
  env: DiscoverySourceEnv = process.env,
): boolean {
  return ["0", "false", "no", "off"].includes(
    (env[flag] ?? "").trim().toLowerCase(),
  );
}

export type DiscoverySourceFactory = (
  env: DiscoverySourceEnv,
) => DiscoverySourceResolution;

/**
 * Sources that RUN ALONGSIDE the primary Apollo pass. Apollo is deliberately
 * absent: it is the primary source and `run.ts` still drives it directly, so
 * listing it here would run it twice. `apolloOrganizationSource` below exists
 * so the interface is provably not SerpApi-shaped, and is the seam for moving
 * the primary pass behind it later.
 */
const SUPPLEMENTARY_FACTORIES: Record<
  string,
  () => Promise<DiscoverySourceFactory>
> = {
  serpapi_google_maps: async () =>
    (await import("@/lib/discovery/sources/serpapi-maps"))
      .resolveSerpapiMapsSource,
};

/**
 * Every supplementary source that is switched on and willing to serve this
 * vertical, plus a reason for each one that is not. Never throws: a
 * misconfigured source must degrade to "contributed nothing, here's why",
 * because an Apollo run must never fail because of an additive source.
 */
export async function resolveSupplementarySources(
  vertical: string,
  env: DiscoverySourceEnv = process.env,
): Promise<{
  sources: CompanyDiscoverySource[];
  skipped: Array<{ name: string; reason: string }>;
}> {
  const sources: CompanyDiscoverySource[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const [name, load] of Object.entries(SUPPLEMENTARY_FACTORIES)) {
    let resolution: DiscoverySourceResolution;
    try {
      resolution = (await load())(env);
    } catch (err) {
      skipped.push({
        name,
        reason: err instanceof Error ? err.message : "failed to load",
      });
      continue;
    }
    if (!resolution.enabled) {
      skipped.push({ name, reason: resolution.reason });
      continue;
    }
    if (!resolution.source.supportsVertical(vertical)) {
      skipped.push({
        name,
        reason: `not enabled for the ${vertical} vertical`,
      });
      continue;
    }
    sources.push(resolution.source);
  }

  return { sources, skipped };
}
