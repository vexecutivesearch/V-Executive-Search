import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapsFetcher, MapsFetchResult } from "@/lib/discovery/sources/serpapi-maps";
import type { MapsLocalResult } from "@/lib/discovery/sources/serpapi-maps-normalize";

/*
 * No live SerpApi calls, ever: the fetcher is injected and returns fixtures
 * shaped like SerpApi's documented google_maps response.
 */

/** Rows the mocked cursor SELECT returns. Empty = no cursor row yet. */
let cursorRows: Array<{ consumed: number; poolExhausted: boolean }> = [];
let cursorReadFails = false;
/** Running total the mocked daily-usage SELECT reports. */
let usageToday = 0;

const insertValues = vi.fn<(row: Record<string, unknown>) => void>();
const onConflictDoUpdate = vi.fn(async () => undefined);

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        void insertValues(row);
        // provider_usage_events inserts are awaited directly; the cursor upsert
        // chains .onConflictDoUpdate. One object satisfies both shapes.
        return Object.assign(Promise.resolve(undefined), {
          onConflictDoUpdate,
        });
      }),
    })),
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn((..._args: unknown[]) => {
          void _args;
          const isCursorQuery = Boolean(projection && "poolExhausted" in projection);
          const rows = isCursorQuery ? cursorRows : [{ total: usageToday }];
          const promise = isCursorQuery
            ? cursorReadFails
              ? Promise.reject(new Error("relation does not exist"))
              : Promise.resolve(rows)
            : Promise.resolve(rows);
          return Object.assign(promise, {
            limit: vi.fn(() => promise),
          });
        }),
      })),
    })),
  },
}));

function mapsResult(overrides: Partial<MapsLocalResult> = {}): MapsLocalResult {
  return {
    title: "Palm Beach Roofing Co",
    address: "1200 Okeechobee Blvd, West Palm Beach, FL 33401, United States",
    phone: "+1 561-555-0142",
    website: "https://www.palmbeachroofing.com/",
    type: "Roofing contractor",
    ...overrides,
  };
}

/** A full page of 20 distinct, qualifying companies. */
function fullPage(tag: string): MapsLocalResult[] {
  return Array.from({ length: 20 }, (_, i) =>
    mapsResult({
      title: `${tag} Roofing ${i}`,
      website: `https://${tag.toLowerCase()}roofing${i}.com`,
    }),
  );
}

function fetcherReturning(
  pages: MapsFetchResult[],
): { fetcher: MapsFetcher; calls: Array<{ q: string; start: number }> } {
  const calls: Array<{ q: string; start: number }> = [];
  let index = 0;
  const fetcher: MapsFetcher = async ({ q, start }) => {
    calls.push({ q, start });
    return pages[Math.min(index++, pages.length - 1)];
  };
  return { fetcher, calls };
}

const CONTEXT = "manual_enrich:discovery:construction:test" as const;

async function buildSource(overrides: Partial<{ runCap: number; fetcher: MapsFetcher }> = {}) {
  const { serpapiMapsSource } = await import("@/lib/discovery/sources/serpapi-maps");
  return serpapiMapsSource({
    apiKey: "test-key",
    verticals: ["construction", "legal"],
    runCap: overrides.runCap ?? 12,
    fetcher: overrides.fetcher,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cursorRows = [];
  cursorReadFails = false;
  usageToday = 0;
  delete process.env.SERPAPI_DISCOVERY_ENABLED;
  delete process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_DISCOVERY_VERTICALS;
  delete process.env.SERPAPI_DISCOVERY_RUN_CAP;
  delete process.env.SERPAPI_DAILY_CREDIT_CAP;
  delete process.env.PAID_EGRESS_ENABLED;
  delete process.env.SERPAPI_EGRESS_ENABLED;
  delete process.env.SERPAPI_PAID_EGRESS_ENABLED;
});

/* ------------------------------------------------------------------ */
/* Resolution — off by default                                         */
/* ------------------------------------------------------------------ */

describe("resolveSerpapiMapsSource", () => {
  it("is off with no configuration at all", async () => {
    const { resolveSerpapiMapsSource } = await import(
      "@/lib/discovery/sources/serpapi-maps"
    );
    const resolution = resolveSerpapiMapsSource({});
    expect(resolution.enabled).toBe(false);
    if (resolution.enabled) return;
    expect(resolution.reason).toMatch(/SERPAPI_DISCOVERY_ENABLED/);
  });

  /*
   * The key already exists in this system for the worker's Google Jobs scrape.
   * Finding it must never be enough to start spending searches on a second
   * consumer of the same monthly quota.
   */
  it("is still off when only the API key is present", async () => {
    const { resolveSerpapiMapsSource } = await import(
      "@/lib/discovery/sources/serpapi-maps"
    );
    const resolution = resolveSerpapiMapsSource({ SERPAPI_API_KEY: "k" });
    expect(resolution.enabled).toBe(false);
  });

  it("is off when the flag is on but no key is configured, and says where the key lives", async () => {
    const { resolveSerpapiMapsSource } = await import(
      "@/lib/discovery/sources/serpapi-maps"
    );
    const resolution = resolveSerpapiMapsSource({
      SERPAPI_DISCOVERY_ENABLED: "true",
    });
    expect(resolution.enabled).toBe(false);
    if (resolution.enabled) return;
    expect(resolution.reason).toMatch(/SERPAPI_API_KEY/);
    expect(resolution.reason).toMatch(/Mac worker/);
  });

  it("enables with both, defaulting to construction and legal only", async () => {
    const { resolveSerpapiMapsSource } = await import(
      "@/lib/discovery/sources/serpapi-maps"
    );
    const resolution = resolveSerpapiMapsSource({
      SERPAPI_DISCOVERY_ENABLED: "true",
      SERPAPI_API_KEY: "k",
    });
    expect(resolution.enabled).toBe(true);
    if (!resolution.enabled) return;
    expect(resolution.source.supportsVertical("construction")).toBe(true);
    expect(resolution.source.supportsVertical("legal")).toBe(true);
    // Google Business categories do not map onto "operations consulting", and
    // a query that returns noise still costs a search.
    expect(resolution.source.supportsVertical("general_professional")).toBe(false);
    expect(resolution.source.supportsVertical("finance_accounting")).toBe(false);
  });

  it("honours an explicit vertical list", async () => {
    const { resolveSerpapiMapsSource } = await import(
      "@/lib/discovery/sources/serpapi-maps"
    );
    const resolution = resolveSerpapiMapsSource({
      SERPAPI_DISCOVERY_ENABLED: "true",
      SERPAPI_API_KEY: "k",
      SERPAPI_DISCOVERY_VERTICALS: "legal",
    });
    if (!resolution.enabled) throw new Error("expected enabled");
    expect(resolution.source.supportsVertical("legal")).toBe(true);
    expect(resolution.source.supportsVertical("construction")).toBe(false);
  });
});

describe("resolveSupplementarySources", () => {
  it("reports the disabled source with a reason rather than throwing", async () => {
    const { resolveSupplementarySources } = await import(
      "@/lib/discovery/sources/source"
    );
    const { sources, skipped } = await resolveSupplementarySources(
      "construction",
      {},
    );
    expect(sources).toHaveLength(0);
    expect(skipped).toEqual([
      {
        name: "serpapi_google_maps",
        reason: expect.stringContaining("SERPAPI_DISCOVERY_ENABLED"),
      },
    ]);
  });

  it("declines a vertical the source does not serve", async () => {
    const { resolveSupplementarySources } = await import(
      "@/lib/discovery/sources/source"
    );
    const { sources, skipped } = await resolveSupplementarySources(
      "general_professional",
      { SERPAPI_DISCOVERY_ENABLED: "true", SERPAPI_API_KEY: "k" },
    );
    expect(sources).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/general_professional/);
  });
});

/* ------------------------------------------------------------------ */
/* Query construction                                                  */
/* ------------------------------------------------------------------ */

describe("query construction", () => {
  it("uses the vertical's existing keyword tags as Maps query seeds", async () => {
    const { mapsQuerySeeds } = await import("@/lib/discovery/sources/serpapi-maps");
    // From config/contact-targets.json — no new config file.
    expect(mapsQuerySeeds("construction")).toContain("roofing");
    expect(mapsQuerySeeds("construction")).toContain("HVAC");
    expect(mapsQuerySeeds("legal")).toContain("law firm");
    expect(mapsQuerySeeds("not_a_vertical")).toEqual([]);
  });

  it("puts the market in q, since google_maps requires a zoom alongside location", async () => {
    const { mapsQuery } = await import("@/lib/discovery/sources/serpapi-maps");
    expect(mapsQuery("roofing", "Palm Beach County, Florida")).toBe(
      "roofing Palm Beach County, Florida",
    );
  });
});

describe("parseMapsPayload", () => {
  it("reads the google_maps bare local_results array", async () => {
    const { parseMapsPayload } = await import("@/lib/discovery/sources/serpapi-maps");
    const parsed = parseMapsPayload({ local_results: [mapsResult()] });
    expect(parsed).toEqual({ ok: true, results: [mapsResult()] });
  });

  it("also reads the google engine's nested local_results.places", async () => {
    const { parseMapsPayload } = await import("@/lib/discovery/sources/serpapi-maps");
    const parsed = parseMapsPayload({
      local_results: { places: [mapsResult()] },
    });
    expect(parsed.ok && parsed.results).toHaveLength(1);
  });

  it("surfaces SerpApi's error field", async () => {
    const { parseMapsPayload } = await import("@/lib/discovery/sources/serpapi-maps");
    expect(
      parseMapsPayload({ error: "Google hasn't returned any results" }),
    ).toEqual({ ok: false, error: "Google hasn't returned any results" });
  });

  it("treats a missing local_results as an empty page, not a crash", async () => {
    const { parseMapsPayload } = await import("@/lib/discovery/sources/serpapi-maps");
    expect(parseMapsPayload({})).toEqual({ ok: true, results: [] });
    expect(parseMapsPayload(null).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Sweep behaviour                                                     */
/* ------------------------------------------------------------------ */

describe("discover", () => {
  it("stops as soon as it has the candidates the run asked for", async () => {
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: fullPage("A") },
      { ok: true, results: fullPage("B") },
      { ok: true, results: fullPage("C") },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    // 20 per search, so 25 candidates needs exactly two searches — not the
    // 12-search run cap.
    expect(calls).toHaveLength(2);
    expect(outcome.unitsSpent).toBe(2);
    expect(outcome.organizations).toHaveLength(25);
  });

  it("bills one search per page and never more than the run cap", async () => {
    // Every page qualifies zero companies, so nothing ever satisfies the limit.
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: [mapsResult({ title: "Acme Staffing Solutions" })] },
    ]);
    const source = await buildSource({ fetcher, runCap: 3 });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(calls).toHaveLength(3);
    expect(outcome.unitsSpent).toBe(3);
    expect(outcome.organizations).toHaveLength(0);
    expect(outcome.rejected.staffing_agency).toBe(3);
  });

  it("resumes from the persisted cursor instead of re-buying page one", async () => {
    // Slot 7 = second seed, second page (start=20).
    cursorRows = [{ consumed: 7, poolExhausted: false }];
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: fullPage("A") },
    ]);
    const source = await buildSource({ fetcher });

    await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 5,
      context: CONTEXT,
    });

    expect(calls[0].start).toBe(20);
    expect(calls[0].q).toBe("HVAC Palm Beach County, Florida");
  });

  it("advances the cursor by searches made, not rows returned", async () => {
    cursorRows = [{ consumed: 4, poolExhausted: false }];
    const { fetcher } = fetcherReturning([
      // A short page must not knock `start` off the 20-result offset grid.
      { ok: true, results: fullPage("A").slice(0, 7) },
      { ok: true, results: fullPage("B") },
    ]);
    const source = await buildSource({ fetcher });

    await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: "serpapi_maps",
        vertical: "construction",
        consumed: 6,
        perPage: 20,
      }),
    );
  });

  /*
   * A dry query means Google has nothing more for THAT seed. Its deeper offsets
   * would be empty pages we still pay for — but the remaining seeds are
   * untouched, so this is not "rotate market".
   */
  it("skips the rest of a dry seed and moves to the next one", async () => {
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: [] },
      { ok: true, results: fullPage("B") },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 10,
      context: CONTEXT,
    });

    expect(calls.map((c) => c.q)).toEqual([
      "roofing Palm Beach County, Florida",
      "HVAC Palm Beach County, Florida",
    ]);
    expect(calls[1].start).toBe(0);
    expect(outcome.poolExhausted).toBe(false);
    expect(outcome.organizations).toHaveLength(10);
  });

  it("spends nothing once the pool is exhausted", async () => {
    cursorRows = [{ consumed: 48, poolExhausted: true }];
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: fullPage("A") },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.unitsSpent).toBe(0);
    expect(outcome.poolExhausted).toBe(true);
    expect(outcome.notes.join(" ")).toMatch(/rotate market/);
  });

  /*
   * Restarting from offset zero after a failed cursor read would silently
   * re-buy every page the operator has already reviewed. An unverifiable
   * position never justifies a paid search.
   */
  it("abandons the sweep when the cursor cannot be read", async () => {
    cursorReadFails = true;
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: fullPage("A") },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.unitsSpent).toBe(0);
    expect(outcome.notes.join(" ")).toMatch(/cursor could not be read/);
  });

  it("stops on a failed search rather than paging into an outage", async () => {
    const { fetcher, calls } = fetcherReturning([
      { ok: false, error: "SerpApi HTTP 429: throttled" },
      { ok: true, results: fullPage("B") },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(calls).toHaveLength(1);
    expect(outcome.organizations).toHaveLength(0);
    expect(outcome.notes.join(" ")).toMatch(/429/);
  });
});

/* ------------------------------------------------------------------ */
/* Cost accounting                                                     */
/* ------------------------------------------------------------------ */

describe("cost accounting", () => {
  it("records exactly one provider_usage_event per search, at cost 1", async () => {
    const { fetcher } = fetcherReturning([
      { ok: true, results: fullPage("A") },
      { ok: true, results: fullPage("B") },
    ]);
    const source = await buildSource({ fetcher });

    await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    const usage = insertValues.mock.calls
      .map(([row]) => row)
      .filter((row) => row.provider === "serpapi");
    expect(usage).toHaveLength(2);
    for (const row of usage) {
      expect(row).toMatchObject({
        provider: "serpapi",
        endpoint: "google_maps/search",
        estimatedCost: 1,
        recordsReturned: 20,
        blocked: false,
      });
    }
  });

  /*
   * SerpApi's pricing FAQ says failed searches are NOT billed, so counting one
   * over-counts. That is the deliberate direction, matching the Mac worker's
   * meter: a guard that over-counts skips Google early; one that under-counts
   * overspends.
   */
  it("counts a failed search too, on purpose", async () => {
    const { fetcher } = fetcherReturning([
      { ok: false, error: "SerpApi HTTP 500" },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(outcome.unitsSpent).toBe(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "serpapi",
        estimatedCost: 1,
        recordsReturned: 0,
        metadata: expect.objectContaining({ failed: true }),
      }),
    );
  });

  it("records the query and offset so spend is auditable per search", async () => {
    const { fetcher } = fetcherReturning([
      { ok: true, results: fullPage("A") },
    ]);
    const source = await buildSource({ fetcher });

    await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 5,
      context: CONTEXT,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "serpapi",
        egressContext: CONTEXT,
        metadata: expect.objectContaining({
          engine: "google_maps",
          q: "roofing Palm Beach County, Florida",
          start: 0,
          usageLabel: "discovery:construction:Palm Beach County, Florida",
        }),
      }),
    );
  });

  /*
   * The non-negotiable one: the same hard stop Apollo and ContactOut have. The
   * cap is shared with the worker's Google Jobs scrape, which posts to the same
   * table, so 400 bounds all SerpApi spend the app can see.
   */
  it("hard-stops at the daily cap without failing the run", async () => {
    process.env.SERPAPI_DAILY_CREDIT_CAP = "2";
    usageToday = 2;
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: fullPage("A") },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.unitsSpent).toBe(0);
    expect(outcome.organizations).toHaveLength(0);
    expect(outcome.notes.join(" ")).toMatch(/daily safety cap reached/);
    expect(outcome.notes.join(" ")).toMatch(/SERPAPI_DAILY_CREDIT_CAP/);
  });

  it("defaults the SerpApi daily cap to the guarded monthly budget over a month", async () => {
    const { providerDailyCap } = await import("@/lib/paid-egress");
    // SERPAPI_MONTHLY_PLAN 15000 × SERPAPI_BUDGET_PCT 0.8 ÷ 30 ≈ 400.
    expect(providerDailyCap("serpapi")).toBe(400);
  });

  it("lets the operator switch SerpApi egress off entirely", async () => {
    process.env.SERPAPI_EGRESS_ENABLED = "false";
    const { fetcher, calls } = fetcherReturning([
      { ok: true, results: fullPage("A") },
    ]);
    const source = await buildSource({ fetcher });

    const outcome = await source.discover({
      vertical: "construction",
      market: "Palm Beach County, Florida",
      limit: 25,
      context: CONTEXT,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.notes.join(" ")).toMatch(/disabled/);
  });

  it("counts SerpApi searches as a billable endpoint", async () => {
    const { endpointConsumesCredits } = await import("@/lib/paid-egress");
    expect(endpointConsumesCredits("serpapi", "google_maps/search")).toBe(true);
  });
});
