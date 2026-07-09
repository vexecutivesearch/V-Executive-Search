import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";
import { parsePhoneValue } from "@/lib/phone-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ApolloPhone {
  sanitized_number?: string;
  raw_number?: string;
  type_cd?: string;
}

interface ApolloWebhookPerson {
  id?: string;
  phone_numbers?: ApolloPhone[];
}

interface ApolloWebhookPayload {
  people?: ApolloWebhookPerson[];
}

function pickBestPhone(phones: ApolloPhone[]): string | null {
  const mobile = phones.find(
    (p) =>
      p.type_cd === "mobile" ||
      p.type_cd === "other" ||
      p.type_cd === "cell",
  );
  if (!mobile) return null;
  return mobile.sanitized_number ?? mobile.raw_number ?? null;
}

export async function POST(request: NextRequest) {
  let payload: ApolloWebhookPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let updated = 0;
  for (const person of payload.people ?? []) {
    const apolloId = person.id;
    const phone = pickBestPhone(person.phone_numbers ?? []);
    if (!apolloId || !phone) continue;

    const normalized = parsePhoneValue(phone);
    if (!normalized) continue;

    const result = await db
      .update(contacts)
      .set({ phone: normalized, personalPhone: normalized })
      .where(eq(contacts.apolloId, apolloId))
      .returning({ id: contacts.id });

    if (result.length > 0) updated += 1;
  }

  return NextResponse.json({ ok: true, contacts_updated: updated });
}
