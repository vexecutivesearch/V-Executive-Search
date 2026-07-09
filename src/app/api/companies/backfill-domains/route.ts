import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { resolveCompanyDomain } from "@/lib/domain-resolver";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Worker-only: Apollo domain lookup for backlog companies missing domains. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "APOLLO_API_KEY not set" }, { status: 503 });
  }

  let body: { company_ids?: string[]; limit?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty ok
  }

  const limit = Math.min(body.limit ?? 50, 100);
  const rows = body.company_ids?.length
    ? await db
        .select()
        .from(companies)
        .where(inArray(companies.id, body.company_ids))
    : await db
        .select()
        .from(companies)
        .where(
          and(eq(companies.status, "new"), isNull(companies.domain)),
        )
        .limit(limit);

  let updated = 0;
  const touchedIds: string[] = [];

  for (const row of rows) {
    if (row.domain) continue;
    const lookup = await resolveCompanyDomain(row.name, apiKey);
    if (!lookup.domain) continue;

    await db
      .update(companies)
      .set({
        domain: lookup.domain,
        domainConfidence: lookup.confidence,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, row.id));

    updated += 1;
    touchedIds.push(row.id);
  }

  if (touchedIds.length) {
    await recomputeCompanyScores(touchedIds);
  }

  return NextResponse.json({ ok: true, updated, company_ids: touchedIds });
}
