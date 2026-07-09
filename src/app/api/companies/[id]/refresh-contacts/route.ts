import { NextRequest, NextResponse } from "next/server";
import { refreshCompanyContactsFromContactOut } from "@/lib/refresh-company-contacts";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** @deprecated Use POST /enrich — kept for backwards compatibility. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const contactOutKey = process.env.CONTACTOUT_API_KEY;
  if (!contactOutKey) {
    return NextResponse.json(
      { error: "CONTACTOUT_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const { id } = await params;
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);

  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const { updated, checked } = await refreshCompanyContactsFromContactOut(
    id,
    contactOutKey,
  );

  return NextResponse.json({
    ok: true,
    updated,
    checked,
    company: company.name,
  });
}
