/**
 * Insert the catalog sending domains that are not already in
 * sending_profiles. Same helper dispatch and Admin → Domains call, so this
 * is the explicit / inspectable path.
 *
 * New domains enter warming at 5/day and rotate with the established three.
 * Existing rows are not touched.
 *
 * Usage:
 *   npx tsx scripts/add-sending-domains.ts             # show the plan
 *   npx tsx scripts/add-sending-domains.ts --apply     # write it
 *
 * Requires DATABASE_URL in .env.local.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import {
  CATALOG_SENDING_DOMAINS,
  DEFAULT_REPLY_TO_ADDRESS,
  fromAddressForDomain,
  rootDomainOf,
} from "../src/lib/outreach/sending-domains-catalog";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (.env.local).");
    process.exitCode = 1;
    return;
  }

  const rows = (await sql`
    select domain, label, status, from_address, reply_to_address,
           ramp_stage, daily_limit
    from sending_profiles
    where kind = 'email_domain'
    order by label
  `) as Array<Record<string, string | number | null>>;

  const have = new Set(
    rows
      .map((row) => String(row.domain ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const replyTo =
    rows.find((row) => row.reply_to_address)?.reply_to_address?.toString() ||
    DEFAULT_REPLY_TO_ADDRESS;

  console.log(APPLY ? "=== APPLYING ===\n" : "=== DRY RUN (pass --apply) ===\n");
  console.log("already in the pool:");
  for (const row of rows) {
    console.log(
      `  ${row.domain}  ${row.status}  cap ${row.daily_limit}/day  from ${row.from_address}`,
    );
  }

  const missing = CATALOG_SENDING_DOMAINS.filter((domain) => !have.has(domain));
  if (!missing.length) {
    console.log("\nEvery catalog domain already has a sending_profiles row.");
    return;
  }

  console.log("\nwill add (warming, 5/day):");
  for (const domain of missing) {
    const from = fromAddressForDomain(domain);
    console.log(`  ${domain}  from ${from}  reply-to ${replyTo}`);
    if (APPLY) {
      await sql`
        insert into sending_profiles (
          kind, label, domain, from_address, reply_to_address, root_domain,
          status, daily_limit, ramp_stage, verified_at, warming_started_at,
          clean_since, created_at, updated_at
        ) values (
          'email_domain', ${domain}, ${domain}, ${from}, ${replyTo},
          ${rootDomainOf(domain)}, 'warming', 5, 0, now(), now(), now(),
          now(), now()
        )
      `;
    }
  }

  if (!APPLY) console.log("\nNothing written. Re-run with --apply.");
  else console.log(`\ninserted ${missing.length} sending domain(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
