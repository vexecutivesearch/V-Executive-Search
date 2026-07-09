import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker-only: re-score full backlog or specific companies. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  let body: { company_ids?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    // empty body = rescore all new companies
  }

  const result = await recomputeCompanyScores(body.company_ids);
  return NextResponse.json({ ok: true, ...result });
}
