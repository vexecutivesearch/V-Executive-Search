import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { verifyWorkerAuth, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const domainsParam = request.nextUrl.searchParams.get("domains");
  if (!domainsParam) {
    return NextResponse.json({ domains: [] });
  }

  const domains = domainsParam
    .split(",")
    .map((d) => d.toLowerCase().trim())
    .filter(Boolean);

  if (domains.length === 0) {
    return NextResponse.json({ domains: [] });
  }

  // Only treat a domain as "existing" when the company already has callable contacts.
  // Companies ingested as jobs-only must still be enriched on the next pipeline run.
  const callableContact = or(
    isNotNull(contacts.personalPhone),
    isNotNull(contacts.phone),
    isNotNull(contacts.personalEmail),
    isNotNull(contacts.email),
    isNotNull(contacts.workEmail),
  );

  const rows = await db
    .selectDistinct({ domain: companies.domain })
    .from(companies)
    .innerJoin(contacts, eq(contacts.companyId, companies.id))
    .where(and(inArray(companies.domain, domains), callableContact));

  return NextResponse.json({
    domains: rows.map((r) => r.domain).filter(Boolean),
  });
}
