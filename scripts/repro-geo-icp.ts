import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { jobLocationInFocus } from "../src/lib/geo-focus";
import { evaluateIcp } from "../src/lib/icp-filter";
import type { pipelineSettings } from "../src/lib/db/schema";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  const [settingsRow] = await sql`
    SELECT * FROM pipeline_settings LIMIT 1
  `;
  const settings = settingsRow as typeof pipelineSettings.$inferSelect;

  console.log("=== PIPELINE SETTINGS ===");
  console.log({
    geographicScope: settings.geographicScope,
    focusState: settings.focusState,
    focusCity: settings.focusCity,
    focusCities: settings.focusCities,
    focusCounties: settings.focusCounties,
  });

  const linkedinRows = await sql`
    SELECT jl.id, jl.location, jl.title, jl.poster_name,
           c.id as company_id, c.name, c.icp_status, c.estimated_employees, c.lead_score
    FROM job_listings jl
    JOIN companies c ON c.id = jl.company_id
    WHERE jl.board ILIKE '%linkedin%'
    ORDER BY jl.created_at DESC
  `;

  console.log(`\n=== LINKEDIN JOBS: ${linkedinRows.length} total ===`);

  type CityStats = {
    total: number;
    geoPass: number;
    geoFail: number;
    icpPass: number;
    icpFail: number;
    icpUnknown: number;
    rejectedLocations: Set<string>;
  };

  const byCity = new Map<string, CityStats>();
  const rejectedGeo: string[] = [];

  for (const row of linkedinRows) {
    const loc = (row.location as string) || "";
    const geoPass = jobLocationInFocus(loc, settings);
    const icp = evaluateIcp({
      companyName: row.name as string,
      estimatedEmployees: row.estimated_employees as number | null,
    });

    const parsedCity = loc.split(",")[0]?.trim() || "(blank)";
    const key = parsedCity.toLowerCase();
    const stats = byCity.get(key) ?? {
      total: 0,
      geoPass: 0,
      geoFail: 0,
      icpPass: 0,
      icpFail: 0,
      icpUnknown: 0,
      rejectedLocations: new Set<string>(),
    };
    stats.total++;
    if (geoPass) stats.geoPass++;
    else {
      stats.geoFail++;
      stats.rejectedLocations.add(loc || "(blank)");
      rejectedGeo.push(loc || "(blank)");
    }
    if (icp === "pass") stats.icpPass++;
    else if (icp === "fail") stats.icpFail++;
    else stats.icpUnknown++;
    byCity.set(key, stats);
  }

  console.log("\n=== BY CITY (parsed first segment) ===");
  console.log(
    "city".padEnd(28),
    "total",
    "geo+",
    "geo-",
    "icp+",
    "icp-",
    "unk",
  );
  for (const [city, s] of [...byCity.entries()].sort(
    (a, b) => b[1].total - a[1].total,
  )) {
    console.log(
      city.padEnd(28),
      String(s.total).padStart(5),
      String(s.geoPass).padStart(5),
      String(s.geoFail).padStart(5),
      String(s.icpPass).padStart(5),
      String(s.icpFail).padStart(5),
      String(s.icpUnknown).padStart(5),
    );
  }

  console.log("\n=== REJECTED GEO LOCATIONS (raw, unique) ===");
  [...new Set(rejectedGeo)].slice(0, 40).forEach((l) => console.log(`  ${JSON.stringify(l)}`));

  const posters = await sql`
    SELECT c.name, c.icp_status, c.estimated_employees, c.lead_score, c.reason_to_call,
           jl.location, ct.name as poster_name
    FROM contacts ct
    JOIN companies c ON c.id = ct.company_id
    JOIN job_listings jl ON jl.company_id = c.id AND jl.board ILIKE '%linkedin%'
    WHERE ct.source_provider = 'linkedin_poster'
    ORDER BY c.updated_at DESC
  `;
  console.log(`\n=== POSTER COMPANIES: ${posters.length} ===`);
  for (const p of posters) {
    const geo = jobLocationInFocus(p.location as string, settings);
    console.log(
      JSON.stringify({
        company: p.name,
        icp: p.icp_status,
        geo,
        location: p.location,
        poster: p.poster_name,
        employees: p.estimated_employees,
        score: p.lead_score,
        reason: p.reason_to_call,
      }),
    );
  }
}

main().catch(console.error);
