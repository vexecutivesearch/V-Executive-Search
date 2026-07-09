import { eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies, contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Worker-only: list contacts pending iMessage check. */
export async function GET(request: NextRequest) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const limit = Math.min(
    Number(request.nextUrl.searchParams.get("limit") ?? 50),
    200,
  );

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
