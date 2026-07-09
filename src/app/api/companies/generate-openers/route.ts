import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { generateOpenersForCompanies } from "@/lib/generate-opener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Worker-only: batch generate Haiku openers for enriched call-sheet companies. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  let body: { company_ids?: string[]; force?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = body.company_ids ?? [];
  if (!ids.length) {
    return NextResponse.json({ ok: true, generated: 0, skipped: 0 });
  }

  const result = await generateOpenersForCompanies(ids, { force: body.force });
  return NextResponse.json({ ok: true, ...result });
}
