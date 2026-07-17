import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { CompanyStatus } from "@/lib/db/schema";
import { getCompanyById } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUSES = new Set<string>([
  "new",
  "contacted",
  "meeting",
  "client",
  "skipped",
]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // CRM/Pipeline callers pass ?skipGeo=1 so job listings stay visible
  // regardless of the current Admin scrape focus.
  const skipGeoFilter = request.nextUrl.searchParams.get("skipGeo") === "1";
  const company = await getCompanyById(id, { skipGeoFilter });
  if (!company) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ company });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.status || !VALID_STATUSES.has(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const [updated] = await db
    .update(companies)
    .set({
      status: body.status as CompanyStatus,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ company: updated });
}
