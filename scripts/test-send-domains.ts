/**
 * Send one live Resend email from each new sending domain.
 *
 * Usage:
 *   npx tsx scripts/test-send-domains.ts
 *   npx tsx scripts/test-send-domains.ts --to hello@proventheory.co
 *
 * Requires RESEND_API_KEY in .env.local (or the environment).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { NEW_SENDING_DOMAINS } from "../src/lib/outreach/sending-domains-catalog";
import { sendCatalogTestEmails } from "../src/lib/outreach/test-send-domains";

const toArg = process.argv.indexOf("--to");
const to =
  toArg > -1 ? process.argv[toArg + 1] : "hello@proventheory.co";

async function main() {
  console.log(`Sending 1 test email from each new domain → ${to}\n`);
  const results = await sendCatalogTestEmails({
    to,
    domains: NEW_SENDING_DOMAINS,
    apiKey: process.env.RESEND_API_KEY ?? null,
  });
  let failed = 0;
  for (const row of results) {
    if (row.ok) {
      console.log(`  ok   ${row.from}  ${row.resendId}`);
    } else {
      failed += 1;
      console.log(`  FAIL ${row.from}  ${row.error}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
