import { config } from "dotenv";

config({ path: ".env.local" });

import { ilike, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies } from "../src/lib/db/schema";
import { recomputeCompanyScores } from "../src/lib/recompute-company-scores";

/**
 * Clear bogus org data on (Listing) pseudo-companies (guessed domains, etc.).
 */
async function main() {
  const rows = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(ilike(companies.name, "(Listing)%"));

  if (!rows.length) {
    console.log("No (Listing) pseudo-companies found.");
    return;
  }

  await db
    .update(companies)
    .set({
      domain: null,
      domainConfidence: "low",
      industry: null,
      estimatedEmployees: null,
      updatedAt: new Date(),
    })
    .where(ilike(companies.name, "(Listing)%"));

  const { scored } = await recomputeCompanyScores(rows.map((r) => r.id));

  console.log(
    JSON.stringify(
      {
        cleared: rows.length,
        rescored: scored,
        sample_before: rows.slice(0, 3).map((r) => ({
          name: r.name,
          domain: r.domain,
        })),
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
