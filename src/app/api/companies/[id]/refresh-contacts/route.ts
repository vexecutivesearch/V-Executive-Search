import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { enrichFromContactOut } from "@/lib/contactout-enrich";
import { isPersonalEmail, parsePhoneValue } from "@/lib/phone-utils";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Re-run ContactOut on existing contacts (personal email/mobile). No Apollo credits. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const contactOutKey = process.env.CONTACTOUT_API_KEY;
  if (!contactOutKey) {
    return NextResponse.json(
      {
        error:
          "CONTACTOUT_API_KEY is not configured. Add it in Vercel Project Settings → Environment Variables.",
      },
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

  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, id));

  const withLinkedIn = rows.filter((c) => c.linkedinUrl);
  if (!withLinkedIn.length) {
    return NextResponse.json({
      ok: true,
      updated: 0,
      message:
        "No contacts have LinkedIn URLs yet. Run Enrich first (Apollo) to capture profile links.",
    });
  }

  let updated = 0;
  for (const contact of withLinkedIn) {
    const co = await enrichFromContactOut(contact.linkedinUrl!, contactOutKey);
    if (!co) continue;

    const workEmail =
      contact.workEmail ??
      (contact.email && !isPersonalEmail(contact.email) ? contact.email : null);

    const personalEmail = co.personalEmail ?? contact.personalEmail;
    const personalPhone = parsePhoneValue(co.personalPhone) ?? contact.personalPhone;
    const primaryEmail = personalEmail ?? contact.email;
    const primaryPhone = personalPhone ?? parsePhoneValue(contact.phone);

    if (
      personalEmail === contact.personalEmail &&
      personalPhone === contact.personalPhone &&
      primaryEmail === contact.email &&
      primaryPhone === contact.phone
    ) {
      continue;
    }

    await db
      .update(contacts)
      .set({
        workEmail: workEmail ?? (co.workEmails[0] || null),
        personalEmail,
        personalPhone,
        email: primaryEmail,
        phone: primaryPhone,
        sourceProvider: "apollo+contactout",
      })
      .where(eq(contacts.id, contact.id));

    updated += 1;
    await new Promise((r) => setTimeout(r, 400));
  }

  return NextResponse.json({
    ok: true,
    updated,
    checked: withLinkedIn.length,
    company: company.name,
  });
}
