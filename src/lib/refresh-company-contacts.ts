import { eq } from "drizzle-orm";
import { enrichFromContactOut } from "@/lib/contactout-enrich";
import {
  mergeSourcedPhones,
  syncContactPhoneFields,
  contactPhonesForDisplay,
} from "@/lib/contact-phones";
import { isPersonalEmail } from "@/lib/phone-utils";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";

/** ContactOut pass on all contacts with LinkedIn — personal email/mobile. */
export async function refreshCompanyContactsFromContactOut(
  companyId: string,
  contactOutKey: string,
): Promise<{ updated: number; checked: number }> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId));

  const withLinkedIn = rows.filter((c) => c.linkedinUrl);
  let updated = 0;

  for (const contact of withLinkedIn) {
    const co = await enrichFromContactOut(contact.linkedinUrl!, contactOutKey);
    if (!co) continue;

    const workEmail =
      contact.workEmail ??
      (contact.email && !isPersonalEmail(contact.email) ? contact.email : null);

    const personalEmail = co.personalEmail ?? contact.personalEmail;
    const phones = mergeSourcedPhones(
      contactPhonesForDisplay(contact),
      co.phones,
    );
    const synced = syncContactPhoneFields({ ...contact, phones });
    const primaryEmail = personalEmail ?? contact.email;

    const changed =
      personalEmail !== contact.personalEmail ||
      primaryEmail !== contact.email ||
      JSON.stringify(synced.phones) !== JSON.stringify(contact.phones ?? []) ||
      synced.phone !== contact.phone ||
      synced.personalPhone !== contact.personalPhone;

    if (!changed) continue;

    await db
      .update(contacts)
      .set({
        workEmail: workEmail ?? co.workEmails[0] ?? null,
        personalEmail,
        phones: synced.phones,
        personalPhone: synced.personalPhone,
        phone: synced.phone,
        companyPhone: synced.companyPhone,
        email: primaryEmail,
        sourceProvider: "apollo+contactout",
      })
      .where(eq(contacts.id, contact.id));

    updated += 1;
    await new Promise((r) => setTimeout(r, 400));
  }

  return { updated, checked: withLinkedIn.length };
}
