import { and, eq, ilike, inArray, isNotNull, not, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, contacts, jobListings } from "@/lib/db/schema";
import { getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";
import { businessDayFirstSeenDates } from "@/lib/timezone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isMarketScanSearch(searchName: string | null | undefined): boolean {
  return searchName?.toLowerCase().includes("market scan") ?? false;
}

/** Worker-only: companies on today's business day that still need contact enrichment. */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? 100),
    500,
  );
  const excludeMarketScan =
    request.nextUrl.searchParams.get("exclude_market_scan") === "1";

  const listDates = businessDayFirstSeenDates();
  const geoSettings = await getGeoFocusSettings();

  const candidateRows = await db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      domainConfidence: companies.domainConfidence,
    })
    .from(companies)
    .where(
      and(
        eq(companies.status, "new"),
        inArray(companies.firstSeen, listDates),
        not(ilike(companies.name, "(Listing)%")),
      ),
    )
    .orderBy(companies.createdAt)
    .limit(limit * 5);

  const result: Array<{
    id: string;
    name: string;
    domain: string | null;
    domain_confidence: string;
    job_listings: Array<{
      title: string;
      board: string | null;
      url: string | null;
      location: string | null;
      search_name: string | null;
      posted_at: string | null;
    }>;
  }> = [];

  for (const row of candidateRows) {
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

    const hasCallable = companyContacts.some(
      (c) =>
        c.personalPhone ||
        c.phone ||
        c.personalEmail ||
        c.email ||
        c.workEmail,
    );
    if (hasCallable) continue;

    const listings = await db
      .select()
      .from(jobListings)
      .where(eq(jobListings.companyId, row.id))
      .orderBy(jobListings.createdAt);

    const inFocusListings = listings.filter((listing) => {
      if (!jobLocationInFocus(listing.location, geoSettings)) return false;
      if (excludeMarketScan && isMarketScanSearch(listing.searchName)) {
        return false;
      }
      return true;
    });

    if (!inFocusListings.length) continue;

    result.push({
      id: row.id,
      name: row.name,
      domain: row.domain,
      domain_confidence: row.domainConfidence,
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

  return NextResponse.json({ companies: result });
}
