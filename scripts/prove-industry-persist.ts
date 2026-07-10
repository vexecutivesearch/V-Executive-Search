import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies } from "../src/lib/db/schema";
import { resolveCompanyOrg } from "../src/lib/domain-resolver";

/**
 * End-to-end proof: Apollo org lookup → DB persist for one company.
 * Usage: npx tsx scripts/prove-industry-persist.ts [company name]
 */
async function main() {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    throw new Error("APOLLO_API_KEY not set in .env.local");
  }

  const nameArg = process.argv.slice(2).join(" ").trim();
  const [row] = nameArg
    ? await db
        .select()
        .from(companies)
        .where(eq(companies.name, nameArg))
        .limit(1)
    : await db
        .select()
        .from(companies)
        .where(eq(companies.status, "new"))
        .limit(1);

  if (!row) {
    throw new Error("No company found to test");
  }

  console.log("Before:", {
    id: row.id,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    estimatedEmployees: row.estimatedEmployees,
  });

  const lookup = await resolveCompanyOrg(row.name, apiKey);
  console.log("Apollo lookup:", lookup);

  if (!lookup.industry) {
    throw new Error("Apollo returned no industry — cannot prove persist path");
  }

  await db
    .update(companies)
    .set({
      domain: row.domain ?? lookup.domain,
      domainConfidence: row.domain ? row.domainConfidence : lookup.confidence,
      industry: lookup.industry,
      estimatedEmployees:
        row.estimatedEmployees ?? lookup.estimatedEmployees ?? null,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, row.id));

  const [after] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, row.id))
    .limit(1);

  console.log("After:", {
    id: after.id,
    name: after.name,
    domain: after.domain,
    industry: after.industry,
    estimatedEmployees: after.estimatedEmployees,
  });

  if (!after.industry?.trim()) {
    throw new Error("FAIL: industry still null after update");
  }

  console.log("PASS: industry persisted");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
