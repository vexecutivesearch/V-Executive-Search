import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { dailyRuns } from "@/lib/db/schema";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import { businessListDate } from "@/lib/timezone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker-only: re-score full backlog or specific companies. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  let body: { company_ids?: string[]; run_date?: string } = {};
  try {
    body = await request.json();
  } catch {
    // empty body = rescore all new companies
  }

  const result = await recomputeCompanyScores(body.company_ids);

  // Full-backlog rescore updates today's funnel ICP count (not per-batch enrich).
  if (!body.company_ids?.length) {
    const runDate = body.run_date ?? businessListDate();
    await db
      .insert(dailyRuns)
      .values({
        runDate,
        icpMatchCount: result.icpMatch,
        companiesScored: result.scored,
      })
      .onConflictDoUpdate({
        target: dailyRuns.runDate,
        set: {
          icpMatchCount: result.icpMatch,
          companiesScored: result.scored,
        },
      });
  }

  return NextResponse.json({ ok: true, ...result });
}
