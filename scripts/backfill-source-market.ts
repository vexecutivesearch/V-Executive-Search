import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { eq, isNull, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies, dailyRuns, jobListings } from "../src/lib/db/schema";
import {
  buildMarketIndex,
  deriveMarketFromListings,
  marketForJobLocation,
} from "../src/lib/market-attribution";
import { DEFAULT_STATE_GEO_CONFIGS } from "../src/lib/state-geo-config";
import {
  REVIEWABLE_STATE_GEO_EXPANSION,
  toStateGeoConfig,
} from "../src/lib/state-geo-expanded-seed";

/**
 * One-time, free backfill of market provenance from job locations:
 * - companies.source_market (null rows only) — derived from the company's
 *   listing locations against the market registry (cross-state metros intact).
 * - daily_runs.market (null rows only) — majority market of that run's listings.
 *
 * No paid APIs touched. Idempotent — only fills nulls.
 * Usage: npx tsx scripts/backfill-source-market.ts [--dry-run]
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const index = buildMarketIndex([
    ...DEFAULT_STATE_GEO_CONFIGS,
    ...REVIEWABLE_STATE_GEO_EXPANSION.map((seed) => toStateGeoConfig(seed)),
  ]);

  // --- companies.source_market ---
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(isNull(companies.sourceMarket));
  console.log(`companies with null source_market: ${rows.length}`);

  const listingRows = await db
    .select({
      companyId: jobListings.companyId,
      location: jobListings.location,
    })
    .from(jobListings);
  const listingsByCompany = new Map<string, Array<{ location: string | null }>>();
  for (const l of listingRows) {
    const list = listingsByCompany.get(l.companyId) ?? [];
    list.push({ location: l.location });
    listingsByCompany.set(l.companyId, list);
  }

  let derived = 0;
  let unresolved = 0;
  const marketCounts = new Map<string, number>();

  for (const row of rows) {
    const market = deriveMarketFromListings(
      listingsByCompany.get(row.id) ?? [],
      index,
    );
    if (!market) {
      unresolved += 1;
      continue;
    }
    marketCounts.set(market, (marketCounts.get(market) ?? 0) + 1);
    derived += 1;
    if (!dryRun) {
      await db
        .update(companies)
        .set({ sourceMarket: market })
        .where(eq(companies.id, row.id));
    }
  }

  // --- daily_runs.market (majority market of that run's listings) ---
  const runs = await db
    .select({ id: dailyRuns.id, runDate: dailyRuns.runDate })
    .from(dailyRuns)
    .where(isNull(dailyRuns.market));
  console.log(`runs with null market: ${runs.length}`);

  const runDateLocations = await db
    .select({
      runDate: jobListings.lastSeenRunDate,
      location: jobListings.location,
      n: sql<number>`count(*)::int`,
    })
    .from(jobListings)
    .where(sql`${jobListings.lastSeenRunDate} IS NOT NULL`)
    .groupBy(jobListings.lastSeenRunDate, jobListings.location);

  const marketVotesByDate = new Map<string, Map<string, number>>();
  for (const row of runDateLocations) {
    if (!row.runDate) continue;
    const market = marketForJobLocation(row.location, index);
    if (!market) continue;
    const votes = marketVotesByDate.get(row.runDate) ?? new Map<string, number>();
    votes.set(market, (votes.get(market) ?? 0) + row.n);
    marketVotesByDate.set(row.runDate, votes);
  }

  let runsUpdated = 0;
  for (const run of runs) {
    const votes = marketVotesByDate.get(run.runDate);
    if (!votes?.size) continue;
    const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    runsUpdated += 1;
    if (!dryRun) {
      await db
        .update(dailyRuns)
        .set({ market: best[0] })
        .where(eq(dailyRuns.id, run.id));
    }
  }

  console.log(
    JSON.stringify(
      {
        dry_run: dryRun,
        companies_processed: rows.length,
        companies_market_derived: derived,
        companies_unresolved: unresolved,
        runs_market_set: runsUpdated,
        by_market: Object.fromEntries(
          [...marketCounts.entries()].sort((a, b) => b[1] - a[1]),
        ),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
