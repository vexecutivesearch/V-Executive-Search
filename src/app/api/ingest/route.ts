import { eq, inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  companies,
  contacts,
  dailyRuns,
  jobListings,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IngestContact {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
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
}

interface IngestCompany {
  name: string;
  domain?: string;
  domain_confidence?: string;
  contacts?: IngestContact[];
  job_listings?: IngestJobListing[];
}

interface IngestPayload {
  run_date: string;
  import_mode?: "pipeline" | "jobs_only";
  metadata?: {
    listings_scraped?: number;
    companies_found?: number;
    companies_skipped_existing?: number;
    companies_enriched?: number;
    contacts_enriched?: number;
    credits_used?: number;
    errors?: string[];
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

async function existingJobUrls(urls: string[]): Promise<Set<string>> {
  const cleaned = urls.map((u) => u.trim()).filter(Boolean);
  if (!cleaned.length) return new Set();

  const rows = await db
    .select({ url: jobListings.url })
    .from(jobListings)
    .where(inArray(jobListings.url, cleaned));

  return new Set(rows.map((r) => r.url).filter(Boolean) as string[]);
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

  const [existingRun] = await db
    .select()
    .from(dailyRuns)
    .where(eq(dailyRuns.runDate, payload.run_date))
    .limit(1);

  const [run] = await db
    .insert(dailyRuns)
    .values({
      runDate: payload.run_date,
      listingsScraped: meta.listings_scraped ?? 0,
      companiesFound: meta.companies_found ?? 0,
      companiesSkippedExisting: meta.companies_skipped_existing ?? 0,
      companiesEnriched: meta.companies_enriched ?? 0,
      contactsEnriched: meta.contacts_enriched ?? 0,
      creditsUsed: meta.credits_used ?? 0,
      errors: meta.errors?.length ? JSON.stringify(meta.errors) : null,
    })
    .onConflictDoUpdate({
      target: dailyRuns.runDate,
      set: {
        listingsScraped: jobsOnly
          ? (existingRun?.listingsScraped ?? 0) + (meta.listings_scraped ?? 0)
          : (meta.listings_scraped ?? 0),
        companiesFound: jobsOnly
          ? (existingRun?.companiesFound ?? 0) + (meta.companies_found ?? 0)
          : (meta.companies_found ?? 0),
        companiesSkippedExisting: meta.companies_skipped_existing ?? 0,
        companiesEnriched: meta.companies_enriched ?? 0,
        contactsEnriched: meta.contacts_enriched ?? 0,
        creditsUsed: meta.credits_used ?? 0,
        errors: meta.errors?.length ? JSON.stringify(meta.errors) : null,
      },
    })
    .returning();

  let inserted = 0;
  let updated = 0;
  let jobsInserted = 0;
  let jobsSkipped = 0;

  const allUrls = payload.companies.flatMap((c) =>
    (c.job_listings ?? []).map((j) => j.url?.trim() || "").filter(Boolean),
  );
  const knownUrls = await existingJobUrls(allUrls);

  for (const item of payload.companies) {
    const existing = await findCompany(item);
    let companyId: string;

    if (existing) {
      companyId = existing.id;
      updated += 1;
      await db
        .update(companies)
        .set({
          name: item.name,
          domainConfidence:
            item.domain_confidence === "high" ? "high" : existing.domainConfidence,
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
          firstSeen: jobsOnly
            ? earliestFirstSeen(item, payload.run_date)
            : payload.run_date,
          dailyRunId: run.id,
        })
        .returning();
      companyId = created.id;
      inserted += 1;
    }

    for (const c of item.contacts ?? []) {
      if (!c.email && !c.name) continue;

      const existingForCompany = await db
        .select({ apolloId: contacts.apolloId, email: contacts.email })
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

      await db.insert(contacts).values({
        companyId,
        name: c.name,
        title: c.title ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
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
      if (url && knownUrls.has(url)) {
        jobsSkipped += 1;
        continue;
      }

      await db.insert(jobListings).values({
        companyId,
        title: jl.title,
        board: jl.board ?? null,
        url,
        location: jl.location ?? null,
        searchName: jl.search_name ?? null,
        postedAt: jl.posted_at ? new Date(jl.posted_at) : null,
      });

      if (url) knownUrls.add(url);
      jobsInserted += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    run_id: run.id,
    companies_inserted: inserted,
    companies_updated: updated,
    jobs_inserted: jobsInserted,
    jobs_skipped: jobsSkipped,
  });
}
