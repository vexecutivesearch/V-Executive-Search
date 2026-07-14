import { eq } from "drizzle-orm";
import { enrichFromContactOut } from "@/lib/contactout-enrich";
import {
  contactNeedsContactOutEnrichment,
  getContactOutEnrichNeeds,
  normalizeContactChannels,
  resolvePersonalEmail,
  resolveWorkEmail,
} from "@/lib/contact-enrichment-limits";
import { mergeSourcedPhones } from "@/lib/contact-phones";
import { markContactOutCreditsExhausted } from "@/lib/contactout-credits";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";
import type { PaidEgressContext } from "@/lib/paid-egress";

/** ContactOut pass on contacts missing email/phone — skips fully enriched rows. */
export async function refreshCompanyContactsFromContactOut(
  companyId: string,
  contactOutKey: string,
  options?: { contactOutAvailable?: boolean; context?: PaidEgressContext },
): Promise<{ updated: number; checked: number; phoneApiLocked: boolean }> {
  if (options?.contactOutAvailable === false) {
    return { updated: 0, checked: 0, phoneApiLocked: true };
  }

  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId));

  const withLinkedIn = rows.filter((c) => c.linkedinUrl);
  let updated = 0;
  let phoneApiLocked = false;

  for (const contact of withLinkedIn) {
    if (!contactNeedsContactOutEnrichment(contact)) continue;

    const needs = getContactOutEnrichNeeds(contact);
    const co = await enrichFromContactOut(contact.linkedinUrl!, contactOutKey, {
      needPersonalEmail: needs.needPersonalEmail,
      needWorkEmail: needs.needWorkEmail,
      needPhone: needs.needPhone,
    }, options?.context, companyId);
    if (!co) continue;
    if (co.phoneApiLocked) {
      await markContactOutCreditsExhausted();
      phoneApiLocked = true;
      break;
    }

    const merged = normalizeContactChannels({
      ...contact,
      workEmail: co.workEmail ?? contact.workEmail,
      personalEmail: co.personalEmail ?? contact.personalEmail,
      phones: mergeSourcedPhones(contact.phones, co.phones),
    });

    const changed =
      merged.personalEmail !== resolvePersonalEmail(contact) ||
      merged.workEmail !== resolveWorkEmail(contact) ||
      merged.email !== contact.email ||
      JSON.stringify(merged.phones) !== JSON.stringify(contact.phones ?? []) ||
      merged.phone !== contact.phone ||
      merged.personalPhone !== contact.personalPhone;

    if (!changed) continue;

    await db
      .update(contacts)
      .set({
        workEmail: merged.workEmail,
        personalEmail: merged.personalEmail,
        phones: merged.phones,
        personalPhone: merged.personalPhone,
        phone: merged.phone,
        companyPhone: merged.companyPhone,
        email: merged.email,
        sourceProvider: "apollo+contactout",
      })
      .where(eq(contacts.id, contact.id));

    updated += 1;
    await new Promise((r) => setTimeout(r, 400));
  }

  return { updated, checked: withLinkedIn.length, phoneApiLocked };
}
