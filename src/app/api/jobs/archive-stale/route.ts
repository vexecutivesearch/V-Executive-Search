import { and, isNull, lt } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { jobListings } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STALE_DAYS = 45;

/** Worker-only: archive job listings not seen in 45+ days. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STALE_DAYS);

  const archived = await db
    .update(jobListings)
    .set({ archivedAt: new Date() })
    .where(
      and(
        isNull(jobListings.archivedAt),
        lt(jobListings.lastSeenAt, cutoff),
      ),
    )
    .returning({ id: jobListings.id });

  return NextResponse.json({
    ok: true,
    archived: archived.length,
    stale_days: STALE_DAYS,
  });
}
