import { inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, jobListings } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Worker-facing resight lookup for marginal-yield pagination: which of these
 * scraped job URLs / company names already exist in the CRM. One batched
 * POST per SerpApi page — the worker computes the per-page net-new ratio and
 * stops paginating when a page is mostly resights. Read-only; ingest/resight
 * tracking itself is unchanged.
 */

const MAX_BATCH = 500;

type KnownPayload = {
  urls?: string[];
  companies?: string[];
};

function cleanList(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .slice(0, MAX_BATCH),
    ),
  ];
}

/** Same collapse ingest uses (normalizeCompanyKey) so "known" matches resight. */
function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(
      /\b(inc|incorporated|llc|l l c|corp|corporation|co|company|ltd|limited|plc|group|holdings)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  let payload: KnownPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const urls = cleanList(payload.urls);
  const companyNames = cleanList(payload.companies);

  const knownUrls: string[] = [];
  if (urls.length) {
    const rows = await db
      .select({ url: jobListings.url })
      .from(jobListings)
      .where(inArray(jobListings.url, urls));
    const found = new Set(rows.map((r) => r.url ?? ""));
    knownUrls.push(...urls.filter((u) => found.has(u)));
  }

  const knownCompanies: string[] = [];
  if (companyNames.length) {
    // Cheap indexed-ish pass first: exact lowercase name match.
    const lowered = companyNames.map((n) => n.toLowerCase());
    const exactRows = await db
      .select({ name: companies.name })
      .from(companies)
      .where(inArray(sql`lower(trim(${companies.name}))`, lowered));
    const exact = new Set(exactRows.map((r) => r.name.trim().toLowerCase()));

    const stillUnknown = companyNames.filter(
      (n) => !exact.has(n.toLowerCase()),
    );
    let normalizedKnown = new Set<string>();
    if (stillUnknown.length) {
      // Normalized-key fallback matches ingest's findCompany collapse.
      // Name-column-only scan — fine at current table size.
      const allNames = await db.select({ name: companies.name }).from(companies);
      const existingKeys = new Set(
        allNames.map((r) => normalizeCompanyKey(r.name)).filter(Boolean),
      );
      normalizedKnown = new Set(
        stillUnknown.filter((n) => {
          const key = normalizeCompanyKey(n);
          return Boolean(key) && existingKeys.has(key);
        }),
      );
    }

    knownCompanies.push(
      ...companyNames.filter(
        (n) => exact.has(n.toLowerCase()) || normalizedKnown.has(n),
      ),
    );
  }

  return NextResponse.json({
    known_urls: knownUrls,
    known_companies: knownCompanies,
  });
}
