import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  extractApolloPhones,
  mergeSourcedPhones,
  syncContactPhoneFields,
  contactPhonesForDisplay,
} from "@/lib/contact-phones";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ApolloPhone {
  sanitized_number?: string;
  raw_number?: string;
  number?: string;
  type_cd?: string;
  type?: string;
}

interface ApolloWebhookPerson {
  id?: string;
  phone_numbers?: ApolloPhone[];
}

interface ApolloWebhookPayload {
  people?: ApolloWebhookPerson[];
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
    if (!apolloId || !person.phone_numbers?.length) continue;

    const apolloPhones = extractApolloPhones({
      phone_numbers: person.phone_numbers,
    });
    if (!apolloPhones.length) continue;

    const [existing] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.apolloId, apolloId))
      .limit(1);

    if (!existing) continue;

    const phones = mergeSourcedPhones(
      contactPhonesForDisplay(existing),
      apolloPhones,
    );
    const synced = syncContactPhoneFields({ ...existing, phones });

    await db
      .update(contacts)
      .set({
        phones: synced.phones,
        phone: synced.phone,
        personalPhone: synced.personalPhone,
        companyPhone: synced.companyPhone,
      })
      .where(eq(contacts.apolloId, apolloId));

    updated += 1;
  }

  return NextResponse.json({ ok: true, contacts_updated: updated });
}
