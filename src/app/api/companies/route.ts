import { inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { verifyWorkerAuth, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";

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

  const rows = await db
    .select({ domain: companies.domain })
    .from(companies)
    .where(inArray(companies.domain, domains));

  return NextResponse.json({
    domains: rows.map((r) => r.domain).filter(Boolean),
  });
}
