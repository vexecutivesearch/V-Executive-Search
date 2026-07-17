import { NextRequest, NextResponse } from "next/server";
import { isContactOutCreditsAvailable } from "@/lib/contactout-credits";
import { refreshCompanyContactsFromContactOut } from "@/lib/refresh-company-contacts";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";
import { manualEnrichContext } from "@/lib/paid-egress";
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

  const [sampleContact] = await db
    .select({ linkedinUrl: contacts.linkedinUrl })
    .from(contacts)
    .where(eq(contacts.companyId, id))
    .limit(1);
  const contactOutAvailable = await isContactOutCreditsAvailable(
    contactOutKey,
    sampleContact?.linkedinUrl ?? null,
  );

  const { updated, checked } = await refreshCompanyContactsFromContactOut(
    id,
    contactOutKey,
    { contactOutAvailable, context: manualEnrichContext(id) },
  );

  return NextResponse.json({
    ok: true,
    updated,
    checked,
    contactout_available: contactOutAvailable,
    company: company.name,
  });
}
