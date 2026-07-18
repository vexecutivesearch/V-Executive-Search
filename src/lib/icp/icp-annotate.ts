import { ilike, inArray, not } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, companyIcp, jobListings } from "@/lib/db/schema";
import { getIcpConfig } from "./icp-config";
import {
  icpScorer,
  validateAnnotationIntegrity,
  type IcpLeadInput,
} from "./icp-scorer";

export type IcpAnnotateResult = {
  companiesScored: number;
  annotationsWritten: number;
  withFlags: number;
};

/**
 * Annotate companies with ICP scores/flags (upsert into company_icp).
 *
 * ANNOTATIONS ONLY: this never deletes, hides, or reorders a lead, and it
 * reads config flags as committed — with flags OFF the adjusted score equals
 * the base score (pure shadow mode).
 *
 * Pass `companyIds` to annotate only that subset (e.g. the companies just
 * touched by an ingest) — omit it to annotate every company in the DB (the
 * full refresh used by `scripts/icp-annotate.ts`).
 */
export async function annotateCompaniesIcp(
  companyIds?: string[],
): Promise<IcpAnnotateResult> {
  if (companyIds && companyIds.length === 0) {
    return { companiesScored: 0, annotationsWritten: 0, withFlags: 0 };
  }

  const icpConfig = getIcpConfig();

  const companyRows = companyIds
    ? await db.select().from(companies).where(inArray(companies.id, companyIds))
    : await db
        .select()
        .from(companies)
        .where(not(ilike(companies.name, "(Listing)%")));

  if (!companyRows.length) {
    return { companiesScored: 0, annotationsWritten: 0, withFlags: 0 };
  }

  const ids = companyRows.map((c) => c.id);
  const listingRows = await db
    .select({
      companyId: jobListings.companyId,
      title: jobListings.title,
      salaryMin: jobListings.salaryMin,
      salaryMax: jobListings.salaryMax,
      salaryText: jobListings.salaryText,
    })
    .from(jobListings)
    .where(inArray(jobListings.companyId, ids));

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
      console.error(
        `ICP annotate integrity ${annotation.companyName}: ${problems.join("; ")}`,
      );
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
  return {
    companiesScored: annotations.length,
    annotationsWritten: written,
    withFlags: flagged,
  };
}
