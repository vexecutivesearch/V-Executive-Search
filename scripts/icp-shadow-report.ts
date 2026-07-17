import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { writeFileSync } from "fs";
import { ilike, not } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies, jobListings } from "../src/lib/db/schema";
import {
  getIcpConfig,
  withFlag,
  ICP_FLAG_NAMES,
  type IcpConfig,
} from "../src/lib/icp/icp-config";
import {
  icpScorer,
  isHiddenByToggles,
  HARD_EXCLUDE_FLAGS_BY_TOGGLE,
  type IcpAnnotation,
  type IcpLeadInput,
} from "../src/lib/icp/icp-scorer";

/**
 * §7.3 Shadow mode — run the rules in parallel, CHANGE NOTHING, and produce:
 * - totals + per-flag would-be-flagged lists
 * - distributions (score buckets, role types, comp estimated)
 * - the DUAL SCORE per lead (base → adjusted with all scoring flags on)
 * - a PER-FILTER SIMULATION: for every feature flag, "if this flag were ON",
 *   the exact leads it would hide/demote with before → after scores.
 *
 * Usage: npx tsx scripts/icp-shadow-report.ts
 * Output: icp-shadow-report.json + console summary. No data is written.
 */
async function main() {
  const baseConfig = getIcpConfig();

  const companyRows = await db
    .select()
    .from(companies)
    .where(not(ilike(companies.name, "(Listing)%")));
  const listingRows = await db
    .select({
      companyId: jobListings.companyId,
      title: jobListings.title,
      salaryMin: jobListings.salaryMin,
      salaryMax: jobListings.salaryMax,
      salaryText: jobListings.salaryText,
    })
    .from(jobListings);

  const listingsByCompany = new Map<string, IcpLeadInput["listings"]>();
  for (const l of listingRows) {
    const list = listingsByCompany.get(l.companyId) ?? [];
    list.push(l);
    listingsByCompany.set(l.companyId, list);
  }

  const inputs: IcpLeadInput[] = companyRows.map((c) => ({
    companyId: c.id,
    companyName: c.name,
    domain: c.domain,
    baseLeadScore: c.leadScore ?? 0,
    estimatedEmployees: c.estimatedEmployees,
    hiringSignals: c.hiringSignals ?? {},
    listings: listingsByCompany.get(c.id) ?? [],
  }));

  /* Current config (as committed) and all-scoring-on views. */
  const current = icpScorer(inputs, baseConfig);
  let allOnConfig: IcpConfig = baseConfig;
  for (const flag of ICP_FLAG_NAMES) allOnConfig = withFlag(allOnConfig, flag, true);
  const allOn = icpScorer(inputs, allOnConfig);
  const allOnById = new Map(allOn.map((a) => [a.companyId, a]));

  const flagCounts: Record<string, number> = {};
  const flagExamples: Record<string, string[]> = {};
  for (const a of current) {
    for (const flag of a.exclusionFlags) {
      flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
      (flagExamples[flag] ??= []).length < 10 && flagExamples[flag].push(a.companyName);
    }
  }

  const roleDistribution: Record<string, number> = {};
  let compEstimated = 0;
  let compFromListing = 0;
  const scoreBuckets: Record<string, number> = {};
  for (const a of allOn) {
    roleDistribution[a.roleType] = (roleDistribution[a.roleType] ?? 0) + 1;
    if (a.compEstimatedFlag) compEstimated += 1;
    else if (a.compAnnualMax != null) compFromListing += 1;
    const bucket = `${Math.floor(a.icpAdjustedScore / 10) * 10}s`;
    scoreBuckets[bucket] = (scoreBuckets[bucket] ?? 0) + 1;
  }

  /* Dual score — biggest movers in both directions. */
  const dual = allOn
    .map((a) => ({
      company: a.companyName,
      base: a.baseLeadScore,
      adjusted: a.icpAdjustedScore,
      delta: a.icpAdjustedScore - a.baseLeadScore,
      flags: a.exclusionFlags,
      role: a.roleType,
    }))
    .sort((x, y) => x.delta - y.delta);
  const biggestDemotions = dual.slice(0, 25);
  const biggestPromotions = [...dual].reverse().slice(0, 25);

  /* Per-filter simulation: flip each flag ON alone against the current config. */
  const perFilter: Record<
    string,
    {
      would_hide: Array<{ company: string; base: number }>;
      would_demote: Array<{ company: string; before: number; after: number }>;
      hidden_count: number;
      demoted_count: number;
    }
  > = {};

  const currentById = new Map(current.map((a) => [a.companyId, a]));
  for (const flag of ICP_FLAG_NAMES) {
    const simulated = icpScorer(inputs, withFlag(baseConfig, flag, true));
    const wouldHide: Array<{ company: string; base: number }> = [];
    const wouldDemote: Array<{ company: string; before: number; after: number }> = [];

    for (const sim of simulated) {
      const before = currentById.get(sim.companyId)!;
      const hideToggle = HARD_EXCLUDE_FLAGS_BY_TOGGLE[flag];
      if (hideToggle && isHiddenByToggles(sim, { [flag]: true })) {
        wouldHide.push({ company: sim.companyName, base: sim.baseLeadScore });
      }
      if (sim.icpAdjustedScore < before.icpAdjustedScore) {
        wouldDemote.push({
          company: sim.companyName,
          before: before.icpAdjustedScore,
          after: sim.icpAdjustedScore,
        });
      }
    }

    wouldDemote.sort((a, b) => a.after - b.after);
    perFilter[flag] = {
      hidden_count: wouldHide.length,
      demoted_count: wouldDemote.length,
      would_hide: wouldHide.slice(0, 50),
      would_demote: wouldDemote.slice(0, 50),
    };
  }

  const report = {
    generated_at: new Date().toISOString(),
    total_processed: inputs.length,
    flags_enabled_in_config: Object.entries(baseConfig.flags)
      .filter(([, v]) => v)
      .map(([k]) => k),
    per_flag_counts: flagCounts,
    per_flag_examples: flagExamples,
    distributions: {
      role_type: roleDistribution,
      icp_adjusted_score_buckets: scoreBuckets,
      comp_estimated: compEstimated,
      comp_from_listing: compFromListing,
    },
    dual_score: {
      biggest_demotions: biggestDemotions,
      biggest_promotions: biggestPromotions,
    },
    per_filter_simulation: perFilter,
  };

  writeFileSync("icp-shadow-report.json", JSON.stringify(report, null, 2));

  console.log(`Processed ${inputs.length} companies (nothing written to the DB).`);
  console.log("Per-flag counts:", JSON.stringify(flagCounts));
  console.log("Role distribution:", JSON.stringify(roleDistribution));
  console.log("\nDual score — biggest demotions (all scoring flags ON):");
  for (const row of biggestDemotions.slice(0, 12)) {
    console.log(
      `  ${row.company}: ${row.base} → ${row.adjusted} [${row.flags.join(", ") || "no flags"}]`,
    );
  }
  console.log("\nPer-filter simulation (would hide / would demote):");
  for (const [flag, sim] of Object.entries(perFilter)) {
    console.log(`  ${flag}: hide ${sim.hidden_count} · demote ${sim.demoted_count}`);
  }
  console.log("\nFull report: icp-shadow-report.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/* Referenced for type completeness in the report shape. */
export type { IcpAnnotation };
