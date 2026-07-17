import { and, eq, inArray, isNull, not, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { resolveCompanyOrg } from "@/lib/domain-resolver";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { isListingPseudoCompany } from "@/lib/icp-filter";
import { PaidEgressBlockedError } from "@/lib/paid-egress";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Worker-only: Apollo org lookup for backlog companies missing domain/industry. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "APOLLO_API_KEY not set" }, { status: 503 });
  }

  let body: { company_ids?: string[]; limit?: number; backfill_industry?: boolean } =
    {};
  try {
    body = await request.json();
  } catch {
    // empty ok
  }

  const limit = Math.min(body.limit ?? 50, 100);
  const backfillIndustry = body.backfill_industry !== false;

  const rows = body.company_ids?.length
    ? await db
        .select()
        .from(companies)
        .where(inArray(companies.id, body.company_ids))
    : await db
        .select()
        .from(companies)
        .where(
          and(
            not(sql`${companies.name} ILIKE '(Listing)%'`),
            backfillIndustry
              ? or(
                  isNull(companies.domain),
                  eq(companies.domainConfidence, "low"),
                  isNull(companies.industry),
                  sql`trim(${companies.industry}) = ''`,
                )
              : or(
                  and(eq(companies.status, "new"), isNull(companies.domain)),
                  eq(companies.domainConfidence, "low"),
                ),
          ),
        )
        .limit(limit);

  let updated = 0;
  let industrySet = 0;
  const touchedIds: string[] = [];

  for (const row of rows) {
    if (isListingPseudoCompany(row.name)) continue;

    let lookup: Awaited<ReturnType<typeof resolveCompanyOrg>>;
    try {
      lookup = await resolveCompanyOrg(row.name, apiKey, "scheduled_pipeline");
    } catch (err) {
      if (err instanceof PaidEgressBlockedError) {
        return NextResponse.json(
          {
            error:
              "Apollo domain backfill is blocked until paid egress is explicitly re-enabled.",
            updated,
            industry_set: industrySet,
            company_ids: touchedIds,
          },
          { status: 403 },
        );
      }
      throw err;
    }
    const patch: Partial<typeof companies.$inferInsert> = {};

    if (
      lookup.domain &&
      (!row.domain ||
        (row.domainConfidence === "low" && lookup.confidence === "high"))
    ) {
      patch.domain = lookup.domain;
      patch.domainConfidence = lookup.confidence;
    }
    if (
      backfillIndustry &&
      lookup.industry &&
      (!row.industry || !row.industry.trim())
    ) {
      patch.industry = lookup.industry;
      industrySet += 1;
    }
    if (lookup.estimatedEmployees != null && row.estimatedEmployees == null) {
      patch.estimatedEmployees = lookup.estimatedEmployees;
    }

    if (!Object.keys(patch).length) continue;

    await db
      .update(companies)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(companies.id, row.id));

    updated += 1;
    touchedIds.push(row.id);
  }

  if (touchedIds.length) {
    await recomputeCompanyScores(touchedIds);
  }

  return NextResponse.json({
    ok: true,
    updated,
    industry_set: industrySet,
    company_ids: touchedIds,
  });
}
