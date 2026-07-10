import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import {
  classifyJobLocation,
  jobLocationInFocus,
} from "../src/lib/geo-focus";
import { evaluateIcp, isStaffingAgency } from "../src/lib/icp-filter";
import { getOrCreateSettings } from "../src/lib/pipeline-config";
import { getBacklogCompanies } from "../src/lib/queries";
import { recomputeCompanyScores } from "../src/lib/recompute-company-scores";

async function main() {
  const settings = await getOrCreateSettings();
  const sql = neon(process.env.DATABASE_URL!);

  console.log("=== BEFORE REScore ===");
  const before = await sql`
    SELECT jl.location, count(*)::int as n
    FROM job_listings jl
    WHERE jl.board ILIKE '%linkedin%'
    GROUP BY jl.location ORDER BY n DESC
  `;

  let beforeGeoPass = 0;
  let beforeGeoFail = 0;
  for (const row of before) {
    const loc = row.location as string;
    if (jobLocationInFocus(loc, settings)) beforeGeoPass += Number(row.n);
    else beforeGeoFail += Number(row.n);
  }
  console.log({ linkedinGeoPass: beforeGeoPass, linkedinGeoFail: beforeGeoFail });

  const { scored, icpMatch } = await recomputeCompanyScores();
  console.log("\n=== RESCORE ===", { scored, icpMatch });

  console.log("\n=== AFTER REScore ===");
  const linkedin = await sql`
    SELECT jl.location, c.name, c.icp_status, c.lead_score, c.reason_to_call
    FROM job_listings jl
    JOIN companies c ON c.id = jl.company_id
    WHERE jl.board ILIKE '%linkedin%'
  `;
  let afterGeoPass = 0;
  let afterGeoFail = 0;
  let icpPass = 0;
  let icpFail = 0;
  let icpUnknown = 0;
  const rejected: string[] = [];
  for (const row of linkedin) {
    const loc = row.location as string;
    if (jobLocationInFocus(loc, settings)) afterGeoPass++;
    else {
      afterGeoFail++;
      rejected.push(loc);
    }
    if (row.icp_status === "pass") icpPass++;
    else if (row.icp_status === "fail") icpFail++;
    else icpUnknown++;
  }

  const backlog = await getBacklogCompanies();
  const posterBacklog = backlog.filter((c) =>
    c.contacts.some((ct) => ct.sourceProvider === "linkedin_poster"),
  );

  console.log({
    linkedinRows: linkedin.length,
    geoPass: afterGeoPass,
    geoFail: afterGeoFail,
    icpPass,
    icpFail,
    icpUnknown,
    backlogTotal: backlog.length,
    posterInBacklog: posterBacklog.length,
  });

  console.log("\n=== STAGE TABLE (sample) ===");
  const samples = [
    "Boca Raton, FL",
    "Palm Beach Gardens, FL",
    "West Palm Beach, FL",
    "Miami, FL",
    "Loxahatchee, FL, US",
  ];
  for (const loc of samples) {
    console.log(loc, classifyJobLocation(loc, settings));
  }

  console.log("\n=== POSTER BACKLOG ===");
  for (const c of posterBacklog.slice(0, 5)) {
    console.log({
      company: c.name,
      score: c.leadScore,
      icp: c.icpStatus,
      reason: c.reasonToCall,
      staffing: isStaffingAgency(c.name),
    });
  }

  if (rejected.length) {
    console.log("\n=== STILL REJECTED GEO ===");
    [...new Set(rejected)].forEach((l) => console.log(JSON.stringify(l)));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
