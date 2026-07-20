import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { dailyRuns } from "@/lib/db/schema";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import { businessListDate, businessRunSlot } from "@/lib/timezone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Worker-only: re-score full backlog or specific companies.
 *
 * Full-backlog rescore updates ICP/scored counters on an *existing* scrape
 * row only. It must never INSERT a zero-listing daily_runs shell — that
 * shows up on /runs as "× no run" with a blank market when the 5 AM scrape
 * failed or is still running, which is exactly what happened on 2026-07-20.
 */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  let body: { company_ids?: string[]; run_date?: string; run_slot?: string } =
    {};
  try {
    body = await request.json();
  } catch {
    // empty body = rescore all new companies
  }

  const result = await recomputeCompanyScores(body.company_ids);

  if (!body.company_ids?.length) {
    const runDate = body.run_date ?? businessListDate();
    const runSlot = body.run_slot ?? businessRunSlot();

    const [existing] = await db
      .select()
      .from(dailyRuns)
      .where(
        and(eq(dailyRuns.runDate, runDate), eq(dailyRuns.runSlot, runSlot)),
      )
      .limit(1);

    if (existing && (existing.listingsScraped ?? 0) > 0) {
      await db
        .update(dailyRuns)
        .set({
          icpMatchCount: result.icpMatch,
          companiesScored: result.scored,
        })
        .where(eq(dailyRuns.id, existing.id));
    } else if (!existing) {
      console.warn(
        `[rescore] no scrape row for ${runDate} ${runSlot} — skipped creating ghost daily_runs ` +
          `(scored=${result.scored}, icpMatch=${result.icpMatch})`,
      );
    } else {
      console.warn(
        `[rescore] scrape row for ${runDate} ${runSlot} has 0 listings — not writing scored/icp ` +
          `(likely a prior ghost; scored=${result.scored})`,
      );
    }
  }

  return NextResponse.json({ ok: true, ...result });
}
