import { eq, inArray } from "drizzle-orm";
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
  source_provider?: string;
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
        listingsScraped: meta.listings_scraped ?? 0,
        companiesFound: meta.companies_found ?? 0,
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

  for (const item of payload.companies) {
    const domain = item.domain?.toLowerCase().trim() || null;

    let companyId: string;
    const existing = domain
      ? await db
          .select()
          .from(companies)
          .where(eq(companies.domain, domain))
          .limit(1)
      : [];

    if (existing.length > 0) {
      companyId = existing[0].id;
      updated += 1;
      await db
        .update(companies)
        .set({
          name: item.name,
          domainConfidence:
            item.domain_confidence === "high" ? "high" : "low",
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
    } else {
      const [created] = await db
        .insert(companies)
        .values({
          name: item.name,
          domain,
          domainConfidence:
            item.domain_confidence === "high" ? "high" : "low",
          firstSeen: payload.run_date,
          dailyRunId: run.id,
        })
        .returning();
      companyId = created.id;
      inserted += 1;
    }

    for (const c of item.contacts ?? []) {
      if (!c.email && !c.name) continue;
      await db.insert(contacts).values({
        companyId,
        name: c.name,
        title: c.title ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
        linkedinUrl: c.linkedin_url ?? null,
        sourceProvider: c.source_provider ?? "apollo",
      });
    }

    for (const jl of item.job_listings ?? []) {
      await db.insert(jobListings).values({
        companyId,
        title: jl.title,
        board: jl.board ?? null,
        url: jl.url ?? null,
        location: jl.location ?? null,
        searchName: jl.search_name ?? null,
        postedAt: jl.posted_at ? new Date(jl.posted_at) : null,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    run_id: run.id,
    companies_inserted: inserted,
    companies_updated: updated,
  });
}
