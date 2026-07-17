import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { getIcpConfig } from "../src/lib/icp/icp-config";
import { annotateCompaniesIcp } from "../src/lib/icp/icp-annotate";

/**
 * Annotate every company with ICP scores/flags (upsert into company_icp).
 *
 * ANNOTATIONS ONLY: this never deletes, hides, or reorders a lead, and it
 * reads config flags as committed — with flags OFF the adjusted score equals
 * the base score (pure shadow mode).
 *
 * This is a full-DB refresh; new companies are annotated automatically after
 * every ingest (see `annotateCompaniesIcp` calls in the ingest API), so this
 * script is now only needed for backfills or after changing `icp-config.json`.
 *
 * Usage: npx tsx scripts/icp-annotate.ts
 */
async function main() {
  const icpConfig = getIcpConfig();
  const result = await annotateCompaniesIcp();

  console.log(
    JSON.stringify(
      {
        companies_scored: result.companiesScored,
        annotations_written: result.annotationsWritten,
        with_flags: result.withFlags,
        flags_enabled: Object.entries(icpConfig.flags)
          .filter(([, v]) => v)
          .map(([k]) => k),
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
