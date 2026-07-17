import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  dailyRuns,
  jobListings,
} from "@/lib/db/schema";
import { jobUrlFingerprint } from "@/lib/hiring-signals";
import {
  augmentScrapeFunnelWithGeo,
  mergeFunnel,
  measureDbFunnel,
  type PipelineFunnel,
} from "@/lib/pipeline-funnel";
import { getGeoFocusSettings } from "@/lib/geo-focus";
import { activeMarketLabel } from "@/lib/market-attribution";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import type { IcpStatus } from "@/lib/db/schema";
import { normalizeRunSlot } from "@/lib/timezone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mergeRunErrors(
  existing: string | null | undefined,
  incoming: string[] | undefined,
): string | null {
  if (!incoming?.length) return existing ?? null;
  const prev: string[] = existing ? JSON.parse(existing) : [];
  const merged = [...prev, ...incoming];
  return merged.length ? JSON.stringify(merged) : null;
}

interface IngestContact {
  name: string;
  title?: string;
  email?: string;
  work_email?: string;
  personal_email?: string;
  phone?: string;
  personal_phone?: string;
  company_phone?: string;
  phones?: Array<{
    number: string;
    source: "apollo" | "contactout";
    kind?: "mobile" | "work" | "company" | "other";
  }>;
  linkedin_url?: string;
  apollo_id?: string;
  source_provider?: string;
  location_matched?: boolean;
  contact_location?: string;
  job_location?: string;
}

interface IngestJobListing {
  title: string;
  board?: string;
  url?: string;
  location?: string;
  search_name?: string;
  posted_at?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  salary_text?: string | null;
  poster_name?: string;
  poster_title?: string;
  poster_linkedin_url?: string;
}

interface IngestCompany {
  id?: string;
  name: string;
  domain?: string;
  domain_confidence?: string;
  estimated_employees?: number;
  industry?: string;
  icp_status?: IcpStatus;
  enrich_run_date?: string;
  contacts?: IngestContact[];
  job_listings?: IngestJobListing[];
}

interface IngestPayload {
  run_date: string;
  /** am | pm | manual — defaults to am when omitted (legacy workers). */
  run_slot?: string;
  import_mode?: "pipeline" | "jobs_only" | "enrich_only";
  metadata?: {
    listings_scraped?: number;
    companies_found?: number;
    companies_skipped_existing?: number;
    companies_enriched?: number;
    contacts_enriched?: number;
    credits_used?: number;
    icp_match_count?: number;
    enrichment_quota?: number;
    companies_scored?: number;
    companies_deferred?: number;
    errors?: string[];
    funnel?: Record<string, unknown>;
  };
  companies: IngestCompany[];
}

function earliestFirstSeen(
  item: IngestCompany,
  runDate: string,
): string {
  const dates = (item.job_listings ?? [])
    .map((j) => j.posted_at?.slice(0, 10))
    .filter((d): d is string => Boolean(d));
  if (dates.length) return dates.sort()[0];
  return runDate;
}

function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(
      /\b(inc|incorporated|llc|l l c|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function findCompany(item: IngestCompany) {
  if (item.id) {
    const [byId] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, item.id))
      .limit(1);
    if (byId) return byId;
  }

  const domain = item.domain?.toLowerCase().trim() || null;
  if (domain) {
    const [byDomain] = await db
      .select()
      .from(companies)
      .where(eq(companies.domain, domain))
      .limit(1);
    if (byDomain) return byDomain;
  }

  const nameKey = normalizeCompanyKey(item.name);
  if (!nameKey) return null;

  const rows = await db
    .select()
    .from(companies)
    .where(sql`lower(trim(${companies.name})) = ${item.name.trim().toLowerCase()}`)
    .limit(1);
  if (rows[0]) return rows[0];

  const all = await db.select().from(companies);
  return all.find((row) => normalizeCompanyKey(row.name) === nameKey) ?? null;
}

async function findJobByUrl(url: string) {
  const [row] = await db
    .select()
    .from(jobListings)
    .where(eq(jobListings.url, url))
    .limit(1);
  return row ?? null;
}

export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  let payload: IngestPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const meta = payload.metadata ?? {};
  const jobsOnly = payload.import_mode === "jobs_only";
  const enrichOnly = payload.import_mode === "enrich_only";
  const runSlot = normalizeRunSlot(payload.run_slot);

  const [existingRun] = await db
    .select()
    .from(dailyRuns)
    .where(
      and(eq(dailyRuns.runDate, payload.run_date), eq(dailyRuns.runSlot, runSlot)),
    )
    .limit(1);

  const [run] = await db
    .insert(dailyRuns)
    .values({
      runDate: payload.run_date,
      runSlot,
      listingsScraped: meta.listings_scraped ?? 0,
      companiesFound: meta.companies_found ?? 0,
      companiesSkippedExisting: meta.companies_skipped_existing ?? 0,
      companiesEnriched: meta.companies_enriched ?? 0,
      contactsEnriched: meta.contacts_enriched ?? 0,
      creditsUsed: meta.credits_used ?? 0,
      icpMatchCount: meta.icp_match_count ?? 0,
      enrichmentQuota: meta.enrichment_quota ?? 0,
      companiesScored: meta.companies_scored ?? 0,
      companiesDeferred: meta.companies_deferred ?? 0,
      errors: meta.errors?.length ? JSON.stringify(meta.errors) : null,
    })
    .onConflictDoUpdate({
      target: [dailyRuns.runDate, dailyRuns.runSlot],
      set: {
        listingsScraped: jobsOnly
          ? (existingRun?.listingsScraped ?? 0) + (meta.listings_scraped ?? 0)
          : (meta.listings_scraped ?? existingRun?.listingsScraped ?? 0),
        companiesFound: jobsOnly
          ? (existingRun?.companiesFound ?? 0) + (meta.companies_found ?? 0)
          : (meta.companies_found ?? existingRun?.companiesFound ?? 0),
        companiesSkippedExisting:
          meta.companies_skipped_existing ?? existingRun?.companiesSkippedExisting ?? 0,
        companiesEnriched:
          meta.companies_enriched ?? existingRun?.companiesEnriched ?? 0,
        contactsEnriched:
          meta.contacts_enriched ?? existingRun?.contactsEnriched ?? 0,
        creditsUsed: meta.credits_used ?? existingRun?.creditsUsed ?? 0,
        icpMatchCount: enrichOnly
          ? (existingRun?.icpMatchCount ?? 0)
          : (meta.icp_match_count ?? existingRun?.icpMatchCount ?? 0),
        enrichmentQuota: meta.enrichment_quota ?? existingRun?.enrichmentQuota ?? 0,
        companiesScored: meta.companies_scored ?? existingRun?.companiesScored ?? 0,
        companiesDeferred:
          meta.companies_deferred ?? existingRun?.companiesDeferred ?? 0,
        errors: mergeRunErrors(existingRun?.errors, meta.errors),
      },
    })
    .returning();

  let inserted = 0;
  let updated = 0;
  let jobsInserted = 0;
  let jobsResighted = 0;
  const touchedCompanyIds: string[] = [];

  // Market active in Admin when this batch was scraped — provenance tag for
  // the consolidated CRM view. Existing rows keep their original market.
  const ingestGeoSettings = await getGeoFocusSettings();
  const sourceMarket = activeMarketLabel(ingestGeoSettings);

  for (const item of payload.companies) {
    const existing = await findCompany(item);
    let companyId: string;

    if (existing) {
      companyId = existing.id;
      updated += 1;
      const incomingDomain = item.domain?.toLowerCase().trim() || null;
      await db
        .update(companies)
        .set({
          name: item.name,
          domain: incomingDomain ?? existing.domain,
          domainConfidence:
            item.domain_confidence === "high" || existing.domainConfidence === "high"
              ? "high"
              : incomingDomain && !existing.domain
                ? "low"
                : existing.domainConfidence,
          estimatedEmployees:
            item.estimated_employees ?? existing.estimatedEmployees,
          industry: item.industry?.trim() || existing.industry,
          icpStatus: item.icp_status ?? existing.icpStatus,
          enrichedAt: enrichOnly ? new Date() : existing.enrichedAt,
          enrichRunDate: item.enrich_run_date ?? existing.enrichRunDate,
          sourceMarket: existing.sourceMarket ?? sourceMarket,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
    } else {
      const domain = item.domain?.toLowerCase().trim() || null;
      const [created] = await db
        .insert(companies)
        .values({
          name: item.name,
          domain,
          domainConfidence:
            item.domain_confidence === "high" ? "high" : "low",
          estimatedEmployees: item.estimated_employees ?? null,
          industry: item.industry ?? null,
          icpStatus: item.icp_status ?? "unknown",
          firstSeen: jobsOnly
            ? earliestFirstSeen(item, payload.run_date)
            : payload.run_date,
          enrichRunDate: item.enrich_run_date ?? null,
          enrichedAt: enrichOnly ? new Date() : null,
          sourceMarket,
          dailyRunId: run.id,
        })
        .returning();
      companyId = created.id;
      inserted += 1;
    }

    touchedCompanyIds.push(companyId);

    const contactsToIngest = jobsOnly
      ? (item.contacts ?? []).filter(
          (c) =>
            c.source_provider === "linkedin_poster" &&
            (c.linkedin_url || c.name),
        )
      : (item.contacts ?? []).filter((c) => c.email || c.name || c.linkedin_url);

    for (const c of contactsToIngest) {
      if (!c.name && !c.email && !c.linkedin_url) continue;

      const existingForCompany = await db
        .select({
          apolloId: contacts.apolloId,
          email: contacts.email,
          linkedinUrl: contacts.linkedinUrl,
        })
        .from(contacts)
        .where(eq(contacts.companyId, companyId));

      if (
        c.apollo_id &&
        existingForCompany.some((row) => row.apolloId === c.apollo_id)
      ) {
        continue;
      }
      const emailNorm = c.email?.trim().toLowerCase();
      if (
        emailNorm &&
        existingForCompany.some(
          (row) => row.email?.trim().toLowerCase() === emailNorm,
        )
      ) {
        continue;
      }
      const linkedinNorm = c.linkedin_url?.trim().toLowerCase().replace(/\/+$/, "");
      if (
        linkedinNorm &&
        existingForCompany.some(
          (row) =>
            row.linkedinUrl?.trim().toLowerCase().replace(/\/+$/, "") ===
            linkedinNorm,
        )
      ) {
        continue;
      }

      await db.insert(contacts).values({
        companyId,
        name: c.name,
        title: c.title ?? null,
        email: c.email ?? null,
        workEmail: c.work_email ?? null,
        personalEmail: c.personal_email ?? null,
        phone: c.phone ?? null,
        personalPhone: c.personal_phone ?? null,
        companyPhone: c.company_phone ?? null,
        phones: c.phones ?? [],
        linkedinUrl: c.linkedin_url ?? null,
        apolloId: c.apollo_id ?? null,
        sourceProvider: c.source_provider ?? "apollo",
        locationMatched: c.location_matched ?? false,
        contactLocation: c.contact_location ?? null,
        jobLocation: c.job_location ?? null,
      });
    }

    for (const jl of item.job_listings ?? []) {
      const url = jl.url?.trim() || null;
      const now = new Date();

      if (url) {
        const existingJob = await findJobByUrl(url);
        if (existingJob) {
          await db
            .update(jobListings)
            .set({
              sightingsCount: (existingJob.sightingsCount ?? 1) + 1,
              lastSeenAt: now,
              lastSeenRunDate: payload.run_date,
              location: jl.location ?? existingJob.location,
              title: jl.title || existingJob.title,
              posterName: jl.poster_name ?? existingJob.posterName,
              posterTitle: jl.poster_title ?? existingJob.posterTitle,
              posterLinkedinUrl:
                jl.poster_linkedin_url ?? existingJob.posterLinkedinUrl,
              salaryMin: jl.salary_min ?? existingJob.salaryMin,
              salaryMax: jl.salary_max ?? existingJob.salaryMax,
              salaryCurrency: jl.salary_currency ?? existingJob.salaryCurrency,
              salaryText: jl.salary_text ?? existingJob.salaryText,
            })
            .where(eq(jobListings.id, existingJob.id));
          jobsResighted += 1;
          continue;
        }
      }

      await db.insert(jobListings).values({
        companyId,
        title: jl.title,
        board: jl.board ?? null,
        url,
        location: jl.location ?? null,
        searchName: jl.search_name ?? null,
        salaryMin: jl.salary_min ?? null,
        salaryMax: jl.salary_max ?? null,
        salaryCurrency: jl.salary_currency ?? null,
        salaryText: jl.salary_text ?? null,
        postedAt: jl.posted_at ? new Date(jl.posted_at) : null,
        posterName: jl.poster_name ?? null,
        posterTitle: jl.poster_title ?? null,
        posterLinkedinUrl: jl.poster_linkedin_url ?? null,
        urlFingerprint: jobUrlFingerprint(url),
        sightingsCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        lastSeenRunDate: payload.run_date,
      });
      jobsInserted += 1;
    }
  }

  const uniqueIds = [...new Set(touchedCompanyIds)];
  const { scored } = await recomputeCompanyScores(uniqueIds);

  const dbFunnel = await measureDbFunnel();
  const geoSettings = await getGeoFocusSettings();
  const runListings = payload.companies.flatMap((c) =>
    (c.job_listings ?? []).map((jl) => ({
      searchName: jl.search_name,
      board: jl.board,
      location: jl.location,
      url: jl.url,
    })),
  );
  const scrapeFunnel = augmentScrapeFunnelWithGeo(
    (meta.funnel ?? {}) as PipelineFunnel,
    runListings,
    geoSettings,
  );
  const mergedFunnel = mergeFunnel(
    (existingRun?.funnelJson as Record<string, unknown> | null) ?? undefined,
    { ...scrapeFunnel, ...dbFunnel },
  );

  await db
    .update(dailyRuns)
    .set({
      companiesScored: jobsOnly
        ? (existingRun?.companiesScored ?? 0) + scored
        : (meta.companies_scored ?? existingRun?.companiesScored ?? scored),
      funnelJson: mergedFunnel,
    })
    .where(eq(dailyRuns.id, run.id));

  return NextResponse.json({
    ok: true,
    run_id: run.id,
    companies_inserted: inserted,
    companies_updated: updated,
    jobs_inserted: jobsInserted,
    jobs_resighted: jobsResighted,
    companies_scored: scored,
    funnel: mergedFunnel,
  });
}
