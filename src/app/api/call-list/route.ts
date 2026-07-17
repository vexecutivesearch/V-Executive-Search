import { desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  companyActivities,
  contacts,
} from "@/lib/db/schema";
import { isCallStatus } from "@/lib/call-status";
import { contactIsCallable } from "@/lib/lead-score";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List entries, or check membership for one company (?company_id=). */
export async function GET(request: NextRequest) {
  const companyId = request.nextUrl.searchParams.get("company_id");

  if (companyId) {
    const [entry] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, companyId))
      .limit(1);
    return NextResponse.json({ entry: entry ?? null });
  }

  const entries = await db
    .select()
    .from(callListEntries)
    .orderBy(desc(callListEntries.addedAt));
  return NextResponse.json({ entries });
}

/** Approve a company onto the call list ("Add to Call List: Yes"). */
export async function POST(request: NextRequest) {
  let body: {
    company_id?: string;
    contact_id?: string;
    call_status?: string;
    assigned_to?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const companyId = body.company_id?.trim();
  if (!companyId) {
    return NextResponse.json({ error: "company_id is required" }, { status: 400 });
  }

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  const [existing] = await db
    .select()
    .from(callListEntries)
    .where(eq(callListEntries.companyId, companyId))
    .limit(1);
  if (existing) {
    return NextResponse.json({ entry: existing, already_on_list: true });
  }

  // Primary contact: explicit pick, else best callable by outreach priority.
  let primaryContactId = body.contact_id?.trim() || null;
  if (!primaryContactId) {
    const companyContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, companyId));
    const best = [...companyContacts]
      .filter(contactIsCallable)
      .sort(compareContactsForOutreach)[0];
    primaryContactId = best?.id ?? null;
  }

  const callStatus =
    body.call_status && isCallStatus(body.call_status)
      ? body.call_status
      : "ready_to_call";

  const [entry] = await db
    .insert(callListEntries)
    .values({
      companyId,
      primaryContactId,
      callStatus,
      assignedTo: body.assigned_to?.trim() || null,
    })
    .onConflictDoNothing({ target: callListEntries.companyId })
    .returning();

  if (!entry) {
    const [raced] = await db
      .select()
      .from(callListEntries)
      .where(eq(callListEntries.companyId, companyId))
      .limit(1);
    return NextResponse.json({ entry: raced, already_on_list: true });
  }

  await db.insert(companyActivities).values({
    companyId,
    contactId: primaryContactId,
    type: "note",
    summary: "Added to call list",
    source: "call_list",
  });

  return NextResponse.json({ entry, already_on_list: false });
}
