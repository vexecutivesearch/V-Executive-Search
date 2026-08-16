import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  extractApolloPhones,
  mergeSourcedPhones,
  syncContactPhoneFields,
  contactPhonesForDisplay,
} from "@/lib/contact-phones";
import { APOLLO_MOBILE_SURCHARGE } from "@/lib/apollo-enrich";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";
import { recordProviderUsageEvent } from "@/lib/paid-egress";

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

    // Apollo charges the 8-credit mobile surcharge only when it actually
    // returns a phone, and that is decided here rather than at request time.
    // Booking it against the day's budget now keeps the guardrail honest
    // without charging for reveals that came back empty.
    await recordProviderUsageEvent(
      "apollo",
      "people/match:mobile",
      "manual_enrich:webhook",
      {
        companyId: existing.companyId,
        contactId: existing.id,
        recordsReturned: apolloPhones.length,
        estimatedCost: APOLLO_MOBILE_SURCHARGE,
        metadata: { apolloId, phones: apolloPhones.length },
      },
    );

    updated += 1;
  }

  return NextResponse.json({ ok: true, contacts_updated: updated });
}
