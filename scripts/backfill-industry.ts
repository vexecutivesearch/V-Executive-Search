import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { and, eq, isNull, not, or, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies } from "../src/lib/db/schema";
import { fetchApolloApiUsage } from "../src/lib/apollo-usage";
import { isListingPseudoCompany } from "../src/lib/icp-filter";
import { resolveCompanyOrg } from "../src/lib/domain-resolver";
import { recomputeCompanyScores } from "../src/lib/recompute-company-scores";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Throttled Apollo org lookup to backfill industry on real companies only.
 *
 * organizations/search may consume Apollo credits per page — run check-apollo-usage first.
 * Usage: npx tsx scripts/backfill-industry.ts --confirm --limit 50 --delay-ms 250
 */
async function main() {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error("APOLLO_API_KEY not set");
  }

  if (!process.argv.includes("--confirm")) {
    const usage = await fetchApolloApiUsage(apiKey);
    console.error(
      "Refusing to run without --confirm.\n",
      JSON.stringify(usage, null, 2),
      "\n",
      usage.creditWarning,
      "\nRe-run with --confirm after checking Apollo billing.",
    );
    process.exit(1);
  }

  const limitArg = process.argv.indexOf("--limit");
  const delayArg = process.argv.indexOf("--delay-ms");
  const limit =
    limitArg >= 0 ? parseInt(process.argv[limitArg + 1] ?? "50", 10) : 50;
  const delayMs =
    delayArg >= 0 ? parseInt(process.argv[delayArg + 1] ?? "250", 10) : 250;

  const rows = await db
    .select()
    .from(companies)
    .where(
      and(
        not(sql`${companies.name} ILIKE '(Listing)%'`),
        or(
          isNull(companies.industry),
          sql`trim(${companies.industry}) = ''`,
        ),
      ),
    )
    .limit(limit);

  console.log(`Backfilling industry for up to ${rows.length} real companies…`);

  let updated = 0;
  let industrySet = 0;
  const touchedIds: string[] = [];

  for (const row of rows) {
    if (isListingPseudoCompany(row.name)) continue;

    const lookup = await resolveCompanyOrg(row.name, apiKey, "manual_script");
    const patch: Partial<typeof companies.$inferInsert> = {};

    if (!row.domain && lookup.domain) {
      patch.domain = lookup.domain;
      patch.domainConfidence = lookup.confidence;
    }
    if (lookup.industry && (!row.industry || !row.industry.trim())) {
      patch.industry = lookup.industry;
      industrySet += 1;
    }
    if (lookup.estimatedEmployees != null && row.estimatedEmployees == null) {
      patch.estimatedEmployees = lookup.estimatedEmployees;
    }

    if (Object.keys(patch).length) {
      await db
        .update(companies)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(companies.id, row.id));
      updated += 1;
      touchedIds.push(row.id);
      console.log(
        `  ✓ ${row.name} → industry=${patch.industry ?? row.industry ?? "—"}`,
      );
    } else {
      console.log(`  · ${row.name} → no org match`);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  if (touchedIds.length) {
    await recomputeCompanyScores(touchedIds);
  }

  const usageAfter = await fetchApolloApiUsage(apiKey);
  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withIndustry: sql<number>`count(*) filter (where industry is not null and trim(industry) <> '')::int`,
    })
    .from(companies)
    .where(not(sql`${companies.name} ILIKE '(Listing)%'`));

  console.log(
    JSON.stringify(
      {
        processed: rows.length,
        updated,
        industry_set: industrySet,
        real_companies_total: stats.total,
        real_companies_with_industry: stats.withIndustry,
        real_industry_pct:
          stats.total > 0
            ? ((100 * stats.withIndustry) / stats.total).toFixed(1)
            : "0.0",
        apollo_usage_after: usageAfter.organizationsSearch,
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
