import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies } from "../src/lib/db/schema";
import {
  evaluateDiscoveryGate,
  gateReasonLabel,
  type GateReason,
  type GateVerdict,
} from "../src/lib/discovery/exclusion-gate";

/**
 * READ-ONLY calibration report for the discovery exclusion gate.
 *
 * Runs the gate over every company already in the pipeline and reports what it
 * would decide. Nothing is written — this exists so a rule change can be
 * measured against real data before it is trusted, and so the operator can see
 * how much of the existing queue the gate disagrees with.
 *
 *   npx tsx scripts/audit-discovery-gate.ts [--pending-only] [--examples N]
 */
async function main() {
  const args = process.argv.slice(2);
  const pendingOnly = args.includes("--pending-only");
  const exampleCount = Number(
    args[args.indexOf("--examples") + 1] ?? (args.includes("--examples") ? 10 : 5),
  );

  const rows = await db
    .select({
      name: companies.name,
      domain: companies.domain,
      industry: companies.industry,
      estimatedEmployees: companies.estimatedEmployees,
      vertical: companies.vertical,
      reviewStatus: companies.reviewStatus,
    })
    .from(companies)
    .where(
      pendingOnly
        ? sql`${companies.reviewStatus} = 'pending'`
        : sql`${companies.name} NOT LIKE '(Listing)%'`,
    );

  const byVerdict: Record<GateVerdict, number> = {
    accept: 0,
    review: 0,
    reject: 0,
  };
  const byReason: Record<string, number> = {};
  const examples: Record<string, string[]> = {};

  for (const row of rows) {
    // annual revenue and ticker are not stored on `companies`, so this audit
    // exercises the name/domain/industry/headcount rules only — the live gate
    // is strictly stricter than what this report shows.
    const decision = evaluateDiscoveryGate({
      name: row.name,
      domain: row.domain,
      industry: row.industry,
      employeeCount: row.estimatedEmployees,
      vertical: row.vertical,
    });
    byVerdict[decision.verdict] += 1;
    byReason[decision.reason] = (byReason[decision.reason] ?? 0) + 1;
    const bucket = (examples[decision.reason] ??= []);
    if (bucket.length < exampleCount) {
      bucket.push(`${row.name} — ${decision.detail}`);
    }
  }

  const total = rows.length || 1;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

  console.log(
    `\nDiscovery exclusion gate — ${rows.length.toLocaleString()} companies` +
      `${pendingOnly ? " (pending review only)" : ""}\n`,
  );
  console.log(`  accept  ${byVerdict.accept.toString().padStart(6)}  ${pct(byVerdict.accept)}`);
  console.log(`  review  ${byVerdict.review.toString().padStart(6)}  ${pct(byVerdict.review)}`);
  console.log(`  reject  ${byVerdict.reject.toString().padStart(6)}  ${pct(byVerdict.reject)}\n`);

  console.log("By reason:");
  for (const [reason, count] of Object.entries(byReason).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(
      `  ${reason.padEnd(22)} ${count.toString().padStart(6)}  ${pct(count)}  (${gateReasonLabel(reason as GateReason)})`,
    );
    for (const example of examples[reason] ?? []) {
      console.log(`      · ${example}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
