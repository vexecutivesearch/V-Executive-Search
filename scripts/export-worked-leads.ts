import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { writeFileSync } from "fs";
import { inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { callListEntries, companies, companyActivities } from "../src/lib/db/schema";

/**
 * Build the worked-leads must-keep fixture (§7.1) from REAL history:
 * every company added to the Call List, given a non-new pipeline status,
 * or with logged call/meeting activity. This is the ground-truth "good lead"
 * set — the ICP layer must never hide any of them.
 *
 * Usage: npx tsx scripts/export-worked-leads.ts
 * Output: src/lib/icp/fixtures/worked-leads.json (commit it — it's the CI gate)
 */
async function main() {
  const [entries, activities] = await Promise.all([
    db.select({ companyId: callListEntries.companyId }).from(callListEntries),
    db
      .selectDistinct({ companyId: companyActivities.companyId })
      .from(companyActivities)
      .where(inArray(companyActivities.type, ["call", "meeting"])),
  ]);

  const workedIds = new Set<string>([
    ...entries.map((e) => e.companyId),
    ...activities.map((a) => a.companyId),
  ]);

  const statusWorked = await db
    .select({ id: companies.id })
    .from(companies)
    .where(or(ne(companies.status, "new"), sql`FALSE`));
  for (const row of statusWorked) workedIds.add(row.id);

  if (!workedIds.size) {
    console.log("No worked leads yet — writing an empty fixture.");
    writeFileSync(
      "src/lib/icp/fixtures/worked-leads.json",
      JSON.stringify({ generated_at: new Date().toISOString(), min_score_floor: 25, leads: [] }, null, 2),
    );
    return;
  }

  const rows = await db
    .select()
    .from(companies)
    .where(inArray(companies.id, [...workedIds]));

  const leads = rows.map((c) => ({
    id: c.id,
    name: c.name,
    domain: c.domain,
    status: c.status,
    lead_score: c.leadScore ?? 0,
  }));

  writeFileSync(
    "src/lib/icp/fixtures/worked-leads.json",
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        /** Worked leads must never drop below this adjusted score. */
        min_score_floor: 25,
        leads,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${leads.length} worked leads to src/lib/icp/fixtures/worked-leads.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
