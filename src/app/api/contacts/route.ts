import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker-only: list contacts for iMessage checks or pending ContactOut API enrichment. */
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

  // iMessage checks only apply to contacts that have a personal email — the
  // only ones the UI shows an iMessage badge for. Excluding email-less
  // "discovered" contacts keeps them from flooding the 50-row batch and
  // starving real candidates (which left badges stuck on "Checking…").
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
    .where(
      and(isNull(contacts.imessageCapable), isNotNull(contacts.personalEmail)),
    )
    .orderBy(desc(contacts.createdAt))
    .limit(limit);

  return NextResponse.json({ contacts: rows });
}
