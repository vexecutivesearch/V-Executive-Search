import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker-only: list contacts for iMessage checks or ContactOut dashboard sync. */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? 50),
    200,
  );
  const pendingContactOut =
    request.nextUrl.searchParams.get("pending_contactout") === "1";

  if (pendingContactOut) {
    const rows = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
        workEmail: contacts.workEmail,
        personalEmail: contacts.personalEmail,
        phone: contacts.phone,
        personalPhone: contacts.personalPhone,
        companyPhone: contacts.companyPhone,
        phones: contacts.phones,
        linkedinUrl: contacts.linkedinUrl,
        sourceProvider: contacts.sourceProvider,
        imessageCapable: contacts.imessageCapable,
        companyName: companies.name,
      })
      .from(contacts)
      .innerJoin(companies, eq(companies.id, contacts.companyId))
      .where(
        and(
          isNotNull(contacts.linkedinUrl),
          or(
            isNull(contacts.phones),
            sql`NOT (${contacts.phones}::jsonb @> '[{"source":"contactout"}]'::jsonb)`,
          ),
        ),
      )
      .limit(limit);

    return NextResponse.json({ contacts: rows });
  }

  const rows = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      workEmail: contacts.workEmail,
      personalEmail: contacts.personalEmail,
      phone: contacts.phone,
      personalPhone: contacts.personalPhone,
      imessageCapable: contacts.imessageCapable,
      companyName: companies.name,
    })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(isNull(contacts.imessageCapable))
    .limit(limit);

  return NextResponse.json({ contacts: rows });
}
