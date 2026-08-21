/**
 * SerpApi Google Maps as a supplementary company discovery source.
 *
 * WHY THIS EXISTS: Apollo's organization search knows headcount, industry and
 * LinkedIn URLs, but its database simply does not contain a large share of the
 * 12-person roofing companies and 4-attorney firms this pipeline targets — and
 * where it does, it usually has no main-line phone for them. Those businesses
 * all maintain a Google Business Profile, because that is how they get
 * customers. Maps is therefore a coverage source, not a cheaper source; see
 * docs/discovery-serpapi-source.md for the cost comparison, which is close to a
 * wash with Apollo in dollars.
 *
 * WHAT IT DOES NOT DO:
 *   - never returns headcount (Maps has none), so everything it finds lands in
 *     the pipeline's existing unknown-size pool;
 *   - never makes a per-company lookup. One search per 20 companies is what
 *     makes this affordable; one search per company would cost more than the
 *     whole Apollo path;
 *   - never touches LinkedIn.
 *
 * SPEND DISCIPLINE, in order of who stops whom:
 *   1. `SERPAPI_DISCOVERY_ENABLED=false` is the kill switch. The API key
 *      turns Maps on, same as the worker's Google Jobs scrape.
 *   2. `assertPaidEgressAllowed("serpapi", …)` before EVERY search, so the
 *      daily cap in paid-egress.ts is a hard stop, shared with the Mac
 *      worker's Google Jobs scrape which posts to the same table.
 *   3. A per-run search cap, so one bad run cannot eat the day.
 *   4. Early exit as soon as the run has the candidates it asked for.
 *   5. A persisted cursor, so day 2 never re-buys day 1's pages — and if the
 *      cursor cannot be read, the sweep is ABANDONED rather than restarted from
 *      offset zero. An unverifiable position never justifies a paid search.
 *
 * Every search is recorded at estimatedCost 1 even when it fails. SerpApi does
 * not bill failed searches, so this over-counts — the same deliberate direction
 * the Mac worker's meter takes, because a guard that over-counts skips Google
 * early and a guard that under-counts overspends.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companyDiscoveryRuns } from "@/lib/db/schema";
import type { DiscoveredOrganization } from "@/lib/domain-resolver";
import { keywordTagsForVertical } from "@/lib/discovery/verticals";
import {
  assertPaidEgressAllowed,
  PaidEgressBlockedError,
  recordProviderUsageEvent,
} from "@/lib/paid-egress";
import {
  marketStateAbbr,
  normalizeMapsPage,
  type MapsLocalResult,
} from "./serpapi-maps-normalize";
import {
  MAPS_PAGE_SIZE,
  mapsPoolSize,
  mapsSlotCapacity,
  slotAfterEmptySeed,
  stepForSlot,
} from "./serpapi-maps-plan";
import type {
  CompanyDiscoverySource,
  DiscoverySourceEnv,
  DiscoverySourceOutcome,
  DiscoverySourceRequest,
  DiscoverySourceResolution,
} from "./source";
import { sourceFlagOff } from "./source";

export const SERPAPI_MAPS_SOURCE = "serpapi_google_maps";

/** Explicit opt-in. Deliberately NOT the worker's SERPAPI_GOOGLE_ENABLED: that
 * flag governs the Google Jobs scrape, and one switch must not silently turn on
 * a second consumer of the shared monthly search quota. */
export const SERPAPI_DISCOVERY_FLAG = "SERPAPI_DISCOVERY_ENABLED";

/** Names operators have used on Vercel. Canonical is SERPAPI_API_KEY. */
const SERPAPI_KEY_ALIASES = [
  "SERPAPI_API_KEY",
  "SERPAPI_KEY",
  "SERP_API_KEY",
] as const;

export function serpapiApiKey(env: DiscoverySourceEnv = process.env): string {
  for (const name of SERPAPI_KEY_ALIASES) {
    const value = (env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** `company_discovery_runs.pool` value. The column is text, so this needs no
 * migration and no enum change. */
export const SERPAPI_MAPS_POOL = "serpapi_maps";

export const SERPAPI_MAPS_ENDPOINT_LABEL = "google_maps/search";

const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";

/**
 * Verticals where Maps categories line up with real businesses. Construction
 * and Legal are Google-Business-Profile-native; "operations consulting" is not,
 * and a query that returns noise still costs a search.
 */
const DEFAULT_VERTICALS = ["construction", "legal"] as const;

const DEFAULT_RUN_CAP = 12;
const REQUEST_TIMEOUT_MS = 20_000;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function envInt(
  env: DiscoverySourceEnv,
  name: string,
  fallback: number,
): number {
  const parsed = Number.parseInt((env[name] ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredVerticals(env: DiscoverySourceEnv): string[] {
  const raw = (env.SERPAPI_DISCOVERY_VERTICALS ?? "").trim();
  if (!raw) return [...DEFAULT_VERTICALS];
  const list = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_VERTICALS];
}

/**
 * Maps query seeds for a vertical, reusing the vertical's existing Apollo
 * keyword tags — "roofing", "HVAC", "law firm" are already exactly what a
 * person would type into Google Maps, so this needs no new config file and
 * stays editable in config/contact-targets.json.
 */
export function mapsQuerySeeds(vertical: string): string[] {
  return keywordTagsForVertical(vertical)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * The market goes in `q` rather than the `location` parameter: SerpApi's
 * google_maps engine documents `location` as requiring a companion `z`/`m` zoom
 * argument, while `q` accepts "anything that you would use in a regular Google
 * Maps search". Putting the place in the query keeps this free of a geocoding
 * step and of a zoom level nobody can tune without live calls.
 */
export function mapsQuery(seed: string, market: string): string {
  return `${seed} ${market}`.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ */
/* Cursor (existing table, existing text column, no migration)         */
/* ------------------------------------------------------------------ */

type SweepCursor = { slotsConsumed: number; poolExhausted: boolean };

async function loadSweepCursor(
  vertical: string,
  market: string,
): Promise<SweepCursor> {
  const [row] = await db
    .select({
      consumed: companyDiscoveryRuns.consumed,
      poolExhausted: companyDiscoveryRuns.poolExhausted,
    })
    .from(companyDiscoveryRuns)
    .where(
      and(
        eq(companyDiscoveryRuns.vertical, vertical),
        eq(companyDiscoveryRuns.market, market),
        eq(companyDiscoveryRuns.pool, SERPAPI_MAPS_POOL),
      ),
    )
    .limit(1);
  if (!row) return { slotsConsumed: 0, poolExhausted: false };
  return {
    slotsConsumed: Math.max(0, row.consumed),
    poolExhausted: row.poolExhausted,
  };
}

async function saveSweepCursor(
  vertical: string,
  market: string,
  cursor: SweepCursor,
  input: { totalEntries: number; lastReturned: number },
): Promise<void> {
  await db
    .insert(companyDiscoveryRuns)
    .values({
      vertical,
      market,
      pool: SERPAPI_MAPS_POOL,
      // `consumed` counts search slots for this pool, and `perPage` records the
      // grid they sit on, so the two are read together and never confused with
      // the Apollo pools' row counting.
      perPage: MAPS_PAGE_SIZE,
      consumed: cursor.slotsConsumed,
      totalEntries: input.totalEntries,
      pagesFetched: 1,
      poolExhausted: cursor.poolExhausted,
      lastRunAt: new Date(),
      lastReturned: input.lastReturned,
    })
    .onConflictDoUpdate({
      target: [
        companyDiscoveryRuns.vertical,
        companyDiscoveryRuns.market,
        companyDiscoveryRuns.pool,
      ],
      set: {
        perPage: MAPS_PAGE_SIZE,
        consumed: cursor.slotsConsumed,
        totalEntries: input.totalEntries,
        pagesFetched: sql`${companyDiscoveryRuns.pagesFetched} + 1`,
        poolExhausted: cursor.poolExhausted,
        lastRunAt: new Date(),
        lastReturned: input.lastReturned,
        updatedAt: new Date(),
      },
    });
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

export type MapsFetchResult =
  | { ok: true; results: MapsLocalResult[] }
  | { ok: false; error: string };

/** Injectable for tests; production uses `fetch`. */
export type MapsFetcher = (input: {
  apiKey: string;
  q: string;
  start: number;
}) => Promise<MapsFetchResult>;

export function parseMapsPayload(payload: unknown): MapsFetchResult {
  if (payload == null || typeof payload !== "object") {
    return { ok: false, error: "SerpApi returned a non-object payload" };
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.error === "string" && body.error.trim()) {
    return { ok: false, error: body.error.trim() };
  }
  const raw = body.local_results;
  // The `google` engine nests local results under `.places`; google_maps
  // returns a bare array. Accept both so a copy-pasted fixture cannot silently
  // parse to zero results.
  const list = Array.isArray(raw)
    ? raw
    : raw != null &&
        typeof raw === "object" &&
        Array.isArray((raw as { places?: unknown }).places)
      ? ((raw as { places: unknown[] }).places)
      : [];
  return {
    ok: true,
    results: list.filter(
      (entry): entry is MapsLocalResult =>
        entry != null && typeof entry === "object",
    ),
  };
}

const httpFetcher: MapsFetcher = async ({ apiKey, q, start }) => {
  const url = new URL(SERPAPI_ENDPOINT);
  url.searchParams.set("engine", "google_maps");
  url.searchParams.set("type", "search");
  url.searchParams.set("q", q);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  if (start > 0) url.searchParams.set("start", String(start));
  url.searchParams.set("api_key", apiKey);

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: `SerpApi HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
      };
    }
    return parseMapsPayload(await resp.json());
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "SerpApi request failed",
    };
  }
};

/* ------------------------------------------------------------------ */
/* Source                                                              */
/* ------------------------------------------------------------------ */

export type SerpapiMapsSourceOptions = {
  apiKey: string;
  verticals: string[];
  /** Hard ceiling on searches for one run. */
  runCap: number;
  fetcher?: MapsFetcher;
};

export function serpapiMapsSource(
  options: SerpapiMapsSourceOptions,
): CompanyDiscoverySource {
  const fetcher = options.fetcher ?? httpFetcher;
  const allowed = new Set(options.verticals.map((v) => v.toLowerCase()));

  return {
    name: SERPAPI_MAPS_SOURCE,
    billingUnit: "search",
    supportsVertical: (vertical) =>
      allowed.has((vertical ?? "").toLowerCase()) &&
      mapsQuerySeeds(vertical).length > 0,

    async discover(
      request: DiscoverySourceRequest,
    ): Promise<DiscoverySourceOutcome> {
      const { vertical, market } = request;
      const limit = Math.max(0, Math.trunc(request.limit));
      const notes: string[] = [];
      const rejected: Record<string, number> = {};
      const organizations: DiscoveredOrganization[] = [];
      const seenKeys = new Set<string>();
      let unitsSpent = 0;

      const seeds = mapsQuerySeeds(vertical);
      if (!seeds.length || limit === 0) {
        return {
          organizations,
          unitsSpent,
          rejected,
          poolExhausted: false,
          notes,
        };
      }

      // An unreadable cursor would mean restarting from offset zero and paying
      // again for pages already reviewed. Never spend on an unverifiable
      // position — stop, loudly.
      let cursor: SweepCursor;
      try {
        cursor = await loadSweepCursor(vertical, market);
      } catch (err) {
        console.error("SerpApi Maps cursor unreadable — sweep skipped:", err);
        notes.push(
          "SerpApi Google Maps skipped: its pagination cursor could not be read, " +
            "and restarting from the first page would re-buy pages already reviewed.",
        );
        return {
          organizations,
          unitsSpent,
          rejected,
          poolExhausted: false,
          notes,
        };
      }

      if (cursor.poolExhausted) {
        notes.push(
          `SerpApi Google Maps pool already exhausted for ${vertical} in ${market} ` +
            "— rotate market or add query seeds. No searches spent.",
        );
        return {
          organizations,
          unitsSpent,
          rejected,
          poolExhausted: true,
          notes,
        };
      }

      const marketState = marketStateAbbr(market);
      if (!marketState) {
        notes.push(
          `SerpApi Google Maps could not read a state from "${market}", so ` +
            "out-of-market results cannot be filtered — results kept as-is.",
        );
      }

      const capacity = mapsSlotCapacity(seeds.length);
      let slot = cursor.slotsConsumed;
      let searches = 0;
      let emptySeeds = 0;
      let stopReason: string | null = null;

      while (
        searches < options.runCap &&
        slot < capacity &&
        organizations.length < limit
      ) {
        const step = stepForSlot(slot);
        const q = mapsQuery(seeds[step.seedIndex], market);
        const usageMetadata = {
          usageLabel: `discovery:${vertical}:${market}`,
          engine: "google_maps",
          q,
          start: step.start,
        };

        try {
          await assertPaidEgressAllowed(
            "serpapi",
            SERPAPI_MAPS_ENDPOINT_LABEL,
            request.context,
            { estimatedCost: 1, metadata: usageMetadata },
          );
        } catch (err) {
          if (!(err instanceof PaidEgressBlockedError)) throw err;
          // Additive source: an Apollo run must not fail because SerpApi hit a
          // cap. Report and hand back whatever was already collected.
          notes.push(`SerpApi Google Maps stopped: ${err.message}`);
          stopReason = "egress_blocked";
          break;
        }

        const fetched = await fetcher({
          apiKey: options.apiKey,
          q,
          start: step.start,
        });
        searches += 1;
        slot += 1;
        unitsSpent += 1;
        await recordProviderUsageEvent(
          "serpapi",
          SERPAPI_MAPS_ENDPOINT_LABEL,
          request.context ?? "automated_scrape",
          {
            recordsReturned: fetched.ok ? fetched.results.length : 0,
            // Counted even on failure: SerpApi does not bill failures, so this
            // over-counts on purpose. Over-counting stops early; the opposite
            // overspends.
            estimatedCost: 1,
            metadata: fetched.ok
              ? usageMetadata
              : { ...usageMetadata, failed: true, error: fetched.error },
          },
        );

        if (!fetched.ok) {
          notes.push(`SerpApi Google Maps search failed: ${fetched.error}`);
          stopReason = "error";
          break;
        }

        if (!fetched.results.length) {
          // This query is spent. Its deeper offsets would be empty pages we
          // still pay for, so skip the rest of the seed — but keep going: the
          // other seeds are untouched and the pool is not exhausted.
          slot = slotAfterEmptySeed(slot - 1);
          emptySeeds += 1;
          continue;
        }

        const page = normalizeMapsPage(fetched.results, {
          marketState,
          seenKeys,
        });
        for (const [reason, count] of Object.entries(page.rejected)) {
          rejected[reason] = (rejected[reason] ?? 0) + count;
        }
        organizations.push(...page.organizations);
      }

      if (emptySeeds) {
        notes.push(
          `${emptySeeds} SerpApi Google Maps query seed(s) ran dry for ${vertical} ` +
            `in ${market}; their remaining pages were skipped rather than bought.`,
        );
      }

      const nextCursor: SweepCursor = {
        slotsConsumed: slot,
        // Only a fully-walked seed list exhausts the pool. A single dry seed or
        // an interrupted run must not tell the operator to rotate market.
        poolExhausted:
          cursor.poolExhausted || (slot >= capacity && stopReason == null),
      };

      if (nextCursor.slotsConsumed !== cursor.slotsConsumed) {
        try {
          await saveSweepCursor(vertical, market, nextCursor, {
            totalEntries: mapsPoolSize(seeds.length),
            lastReturned: organizations.length,
          });
        } catch (err) {
          // Losing the cursor write means the next run re-buys these pages. Say
          // so rather than letting it look free.
          console.error("SerpApi Maps cursor write failed:", err);
          notes.push(
            "SerpApi Google Maps pagination cursor could not be saved — the next " +
              "run will repeat these searches. Investigate before running again.",
          );
        }
      }

      const trimmed = organizations.slice(0, limit);
      if (unitsSpent > 0) {
        const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
        notes.push(
          `SerpApi Google Maps: ${unitsSpent} search(es) → ${trimmed.length} ` +
            `candidate(s), ${rejectedTotal} filtered out before insert` +
            (rejectedTotal
              ? ` (${Object.entries(rejected)
                  .map(([reason, count]) => `${count} ${reason}`)
                  .join(", ")})`
              : "") +
            ". No headcount is available from Maps, so these are size-unknown.",
        );
      }

      return {
        organizations: trimmed,
        unitsSpent,
        rejected,
        poolExhausted: nextCursor.poolExhausted,
        notes,
      };
    },
  };
}

/**
 * On when `SERPAPI_API_KEY` is present, same as the Mac worker's Google Jobs
 * scrape. `SERPAPI_DISCOVERY_ENABLED=false` is the kill switch. The key lives
 * on the worker today — add the same value to Vercel or Maps stays off.
 */
export function resolveSerpapiMapsSource(
  env: DiscoverySourceEnv = process.env,
): DiscoverySourceResolution {
  if (sourceFlagOff(SERPAPI_DISCOVERY_FLAG, env)) {
    return {
      enabled: false,
      reason: `${SERPAPI_DISCOVERY_FLAG} is off`,
    };
  }
  const apiKey = serpapiApiKey(env);
  if (!apiKey) {
    return {
      enabled: false,
      reason:
        "SERPAPI_API_KEY is not set on this Vercel deploy. Add it under " +
        "Settings → Environment Variables for Production (and Preview), " +
        "same value as .env.local / the Mac worker, then Redeploy. " +
        "SERPAPI_DISCOVERY_ENABLED=true alone is not enough.",
    };
  }
  return {
    enabled: true,
    source: serpapiMapsSource({
      apiKey,
      verticals: configuredVerticals(env),
      runCap: envInt(env, "SERPAPI_DISCOVERY_RUN_CAP", DEFAULT_RUN_CAP),
    }),
  };
}
