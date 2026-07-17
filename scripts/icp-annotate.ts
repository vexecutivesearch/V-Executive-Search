import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: "worker/.env" });

import { ilike, inArray, not } from "drizzle-orm";
import { db } from "../src/lib/db";
import { companies, companyIcp, jobListings } from "../src/lib/db/schema";
import { getIcpConfig } from "../src/lib/icp/icp-config";
import {
  icpScorer,
  validateAnnotationIntegrity,
  type IcpLeadInput,
} from "../src/lib/icp/icp-scorer";

/**
 * Annotate every company with ICP scores/flags (upsert into company_icp).
 *
 * ANNOTATIONS ONLY: this never deletes, hides, or reorders a lead, and it
 * reads config flags as committed — with flags OFF the adjusted score equals
 * the base score (pure shadow mode).
 *
 * Usage: npx tsx scripts/icp-annotate.ts
 */
async function main() {
  const icpConfig = getIcpConfig();

  const companyRows = await db
    .select()
    .from(companies)
    .where(not(ilike(companies.name, "(Listing)%")));

  const listingRows = await db
    .select({
      companyId: jobListings.companyId,
      title: jobListings.title,
      salaryMin: jobListings.salaryMin,
      salaryMax: jobListings.salaryMax,
      salaryText: jobListings.salaryText,
    })
    .from(jobListings);

  const listingsByCompany = new Map<string, IcpLeadInput["listings"]>();
  for (const l of listingRows) {
    const list = listingsByCompany.get(l.companyId) ?? [];
    list.push(l);
    listingsByCompany.set(l.companyId, list);
  }

  const inputs: IcpLeadInput[] = companyRows.map((c) => ({
    companyId: c.id,
    companyName: c.name,
    domain: c.domain,
    baseLeadScore: c.leadScore ?? 0,
    estimatedEmployees: c.estimatedEmployees,
    hiringSignals: c.hiringSignals ?? {},
    listings: listingsByCompany.get(c.id) ?? [],
  }));

  const annotations = icpScorer(inputs, icpConfig);

  let integrityFailures = 0;
  for (const annotation of annotations) {
    const problems = validateAnnotationIntegrity(annotation);
    if (problems.length) {
      integrityFailures += 1;
      console.error(`INTEGRITY ${annotation.companyName}: ${problems.join("; ")}`);
    }
  }
  if (integrityFailures > 0) {
    throw new Error(`${integrityFailures} annotations failed integrity — aborting write`);
  }

  // Refresh annotations wholesale (annotation table only; idempotent).
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < annotations.length; i += CHUNK) {
    const chunk = annotations.slice(i, i + CHUNK);
    await db.delete(companyIcp).where(
      inArray(companyIcp.companyId, chunk.map((a) => a.companyId)),
    );
    await db.insert(companyIcp).values(
      chunk.map((a) => ({
        companyId: a.companyId,
        baseLeadScore: a.baseLeadScore,
        icpAdjustedScore: a.icpAdjustedScore,
        exclusionFlags: a.exclusionFlags,
        exclusionConfidence: a.exclusionConfidence,
        roleType: a.roleType,
        roleTypeConfidence: a.roleTypeConfidence,
        compAnnualMin: a.compAnnualMin,
        compAnnualMax: a.compAnnualMax,
        compEstimatedFlag: a.compEstimatedFlag,
        compConfidence: a.compConfidence,
        companySizeBand: a.companySizeBand,
        likelyToUseRecruiter: a.likelyToUseRecruiter,
        enrichmentTier: a.enrichmentTier,
        scoredAt: new Date(),
      })),
    );
    written += chunk.length;
  }

  const flagged = annotations.filter((a) => a.exclusionFlags.length > 0).length;
  console.log(
    JSON.stringify(
      {
        companies_scored: annotations.length,
        annotations_written: written,
        with_flags: flagged,
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
