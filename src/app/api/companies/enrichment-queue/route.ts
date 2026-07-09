import { and, desc, eq, inArray, isNull, ne, not, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";
import { getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";
import { getOrCreateSettings } from "@/lib/pipeline-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isCallable(contact: {
  personalPhone: string | null;
  phone: string | null;
  personalEmail: string | null;
  email: string | null;
  workEmail: string | null;
}): boolean {
  return Boolean(
    contact.personalPhone ||
      contact.phone ||
      contact.personalEmail ||
      contact.email ||
      contact.workEmail,
  );
}

/** Worker-only: ranked backlog queue for just-in-time enrichment. */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const settings = await getOrCreateSettings();
  const geoSettings = await getGeoFocusSettings();
  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? settings.dailyEnrichQuota),
    100,
  );
  const minScore = Number(
    request.nextUrl.searchParams.get("min_score") ?? settings.minScoreForEnrich,
  );

  const candidates = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.status, "new"),
        ne(companies.icpStatus, "fail"),
        sql`${companies.leadScore} >= ${minScore}`,
      ),
    )
    .orderBy(desc(companies.leadScore), desc(companies.updatedAt))
    .limit(limit * 8);

  const result: Array<{
    id: string;
    name: string;
    domain: string | null;
    domain_confidence: string;
    lead_score: number;
    reason_to_call: string | null;
    job_listings: Array<{
      title: string;
      board: string | null;
      url: string | null;
      location: string | null;
      search_name: string | null;
      posted_at: string | null;
    }>;
  }> = [];

  for (const row of candidates) {
    if (result.length >= limit) break;

    const companyContacts = await db
      .select({
        personalPhone: contacts.personalPhone,
        phone: contacts.phone,
        personalEmail: contacts.personalEmail,
        email: contacts.email,
        workEmail: contacts.workEmail,
      })
      .from(contacts)
      .where(eq(contacts.companyId, row.id));

    if (companyContacts.some(isCallable)) continue;

    const listings = await db
      .select()
      .from(jobListings)
      .where(
        and(
          eq(jobListings.companyId, row.id),
          isNull(jobListings.archivedAt),
        ),
      )
      .orderBy(desc(jobListings.sightingsCount), desc(jobListings.lastSeenAt));

    const inFocusListings = listings.filter((listing) =>
      jobLocationInFocus(listing.location, geoSettings),
    );
    if (!inFocusListings.length) continue;

    // Prefer enrichable companies — domain required for Apollo
    if (!row.domain) continue;

    result.push({
      id: row.id,
      name: row.name,
      domain: row.domain,
      domain_confidence: row.domainConfidence,
      lead_score: row.leadScore ?? 0,
      reason_to_call: row.reasonToCall,
      job_listings: inFocusListings.map((listing) => ({
        title: listing.title,
        board: listing.board,
        url: listing.url,
        location: listing.location,
        search_name: listing.searchName,
        posted_at: listing.postedAt?.toISOString() ?? null,
      })),
    });
  }

  return NextResponse.json({
    companies: result,
    quota: settings.dailyEnrichQuota,
    min_score_for_enrich: settings.minScoreForEnrich,
    min_score_for_phone: settings.minScoreForPhone,
  });
}
