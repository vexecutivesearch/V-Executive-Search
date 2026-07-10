import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, jobListings } from "@/lib/db/schema";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker: LinkedIn jobs missing hiring-team / poster data. */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const limit = Math.min(
    200,
    Number(request.nextUrl.searchParams.get("limit") ?? 100),
  );

  const rows = await db
    .select({
      jobId: jobListings.id,
      companyId: companies.id,
      companyName: companies.name,
      title: jobListings.title,
      url: jobListings.url,
      location: jobListings.location,
    })
    .from(jobListings)
    .innerJoin(companies, eq(jobListings.companyId, companies.id))
    .where(
      and(
        ilike(jobListings.board, "%linkedin%"),
        isNull(jobListings.archivedAt),
        isNull(jobListings.posterName),
        sql`${jobListings.url} IS NOT NULL`,
      ),
    )
    .limit(limit);

  return NextResponse.json({ jobs: rows, count: rows.length });
}
