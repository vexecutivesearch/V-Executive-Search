import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import {
  syncContactPhoneFields,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkerContactPatch = {
  imessage_capable?: boolean;
  personal_email?: string | null;
  work_email?: string | null;
  email?: string | null;
  phones?: SourcedPhone[];
  phone?: string | null;
  personal_phone?: string | null;
  company_phone?: string | null;
  source_provider?: string | null;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!verifyWorkerAuth(request)) {
    return unauthorized();
  }

  const { id } = await params;
  let body: WorkerContactPatch;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, id))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const updates: Partial<typeof contacts.$inferInsert> = {};

  if (typeof body.imessage_capable === "boolean") {
    updates.imessageCapable = body.imessage_capable;
  }

  const hasEnrichment =
    "personal_email" in body ||
    "work_email" in body ||
    "email" in body ||
    "phones" in body ||
    "phone" in body ||
    "personal_phone" in body ||
    "company_phone" in body ||
    "source_provider" in body;

  if (hasEnrichment) {
    const mergedPhones = (body.phones ?? existing.phones ?? []) as SourcedPhone[];
    const synced = syncContactPhoneFields({
      phones: mergedPhones,
      phone: body.phone ?? existing.phone,
      personalPhone: body.personal_phone ?? existing.personalPhone,
      companyPhone: body.company_phone ?? existing.companyPhone,
      sourceProvider: body.source_provider ?? existing.sourceProvider,
    });

    if ("personal_email" in body) updates.personalEmail = body.personal_email;
    if ("work_email" in body) updates.workEmail = body.work_email;
    if ("email" in body) updates.email = body.email ?? null;
    if ("phones" in body) updates.phones = body.phones ?? [];
    if ("source_provider" in body) updates.sourceProvider = body.source_provider;
    updates.phone = "phone" in body ? body.phone : synced.phone;
    updates.personalPhone =
      "personal_phone" in body ? body.personal_phone : synced.personalPhone;
    updates.companyPhone =
      "company_phone" in body ? body.company_phone : synced.companyPhone;
  }

  if (!Object.keys(updates).length) {
    return NextResponse.json(
      { error: "No supported fields to update" },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(contacts)
    .set(updates)
    .where(eq(contacts.id, id))
    .returning({ id: contacts.id });

  return NextResponse.json({ ok: true, id: updated.id });
}
