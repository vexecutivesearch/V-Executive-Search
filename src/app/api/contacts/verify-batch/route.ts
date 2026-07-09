import { and, eq, isNull, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { verifyContactEmail } from "@/lib/email-verify";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Worker-only: MX-check emails for call-sheet contacts missing verification. */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? 50),
    100,
  );

  const rows = await db
    .select({
      contact: contacts,
      companyName: companies.name,
    })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(
      and(
        isNull(contacts.emailVerifiedAt),
        or(
          sql`${contacts.personalEmail} IS NOT NULL`,
          sql`${contacts.workEmail} IS NOT NULL`,
          sql`${contacts.email} IS NOT NULL`,
        ),
      ),
    )
    .limit(limit);

  let verified = 0;
  let deliverable = 0;

  for (const { contact } of rows) {
    const result = await verifyContactEmail(contact);
    if (!result) continue;

    await db
      .update(contacts)
      .set({
        emailDeliverable: result.deliverable,
        emailVerifiedAt: new Date(),
        presenceCheckedAt: new Date(),
      })
      .where(eq(contacts.id, contact.id));

    verified += 1;
    if (result.deliverable) deliverable += 1;
  }

  return NextResponse.json({ ok: true, verified, deliverable });
}
