import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies } from "../src/lib/db/schema";

/**
 * Prove worker-style ingest payload persists industry via /api/ingest.
 * Usage: npx tsx scripts/prove-industry-ingest.ts [company name]
 */
async function main() {
  const apiKey = process.env.WORKER_API_KEY;
  const baseUrl = (
    process.env.CRM_API_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");

  if (!apiKey) {
    throw new Error("WORKER_API_KEY not set");
  }

  const nameArg = process.argv.slice(2).join(" ").trim() || "Chewy";
  const [row] = await db
    .select()
    .from(companies)
    .where(eq(companies.name, nameArg))
    .limit(1);

  if (!row) {
    throw new Error(`Company not found: ${nameArg}`);
  }

  const testIndustry = "ingest-proof-industry";
  const runDate = new Date().toISOString().slice(0, 10);

  const payload = {
    run_date: runDate,
    import_mode: "jobs_only" as const,
    metadata: {
      listings_scraped: 0,
      companies_found: 1,
    },
    companies: [
      {
        name: row.name,
        domain: row.domain ?? "chewy.com",
        domain_confidence: "high",
        estimated_employees: 18000,
        industry: testIndustry,
        job_listings: [],
      },
    ],
  };

  const res = await fetch(`${baseUrl}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Ingest failed: ${res.status} ${JSON.stringify(body)}`);
  }

  const [after] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, row.id))
    .limit(1);

  console.log(
    JSON.stringify(
      {
        ingest_ok: true,
        company: after.name,
        industry_before: row.industry,
        industry_after: after.industry,
        pass: after.industry === testIndustry,
      },
      null,
      2,
    ),
  );

  if (after.industry !== testIndustry) {
    throw new Error("FAIL: ingest did not persist industry");
  }

  // Restore prior industry if we had one (avoid leaving test value)
  if (row.industry && row.industry !== testIndustry) {
    await db
      .update(companies)
      .set({ industry: row.industry, updatedAt: new Date() })
      .where(eq(companies.id, row.id));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
