/**
 * Build daily CRM payload with top-10 Hot Listings and dump JSON for the worker email sender.
 * Usage: npx tsx scripts/dump-daily-report-for-email.ts /tmp/crm-report.json
 */
import { config as loadEnv } from "dotenv";
import { writeFileSync } from "fs";
import { resolve } from "path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), "worker/.env"), override: false });

async function main() {
  const outPath = process.argv[2] || "/tmp/vexec-crm-report.json";
  const { getDailyCallSheet } = await import("../src/lib/daily-report");
  const { getHotListingsForEmail } = await import(
    "../src/lib/hot-listings-query"
  );

  const [sheet, hot] = await Promise.all([
    getDailyCallSheet(),
    getHotListingsForEmail({ limit: 10, include: true }),
  ]);

  const payload = {
    ...sheet,
    hot_listings: hot.items,
    hot_listings_count: hot.total,
    hot_listings_included: true,
  };

  writeFileSync(outPath, JSON.stringify(payload));
  console.log(
    `Wrote ${outPath}: Hot listings emailed ${hot.items.length} of ${hot.total} · call sheet ${sheet.leads.length}`,
  );
  if (hot.items[0]) {
    console.log(`Sample: ${hot.items[0].headline}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
