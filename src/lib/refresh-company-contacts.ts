import { eq } from "drizzle-orm";
import { enrichFromContactOut } from "@/lib/contactout-enrich";
import { isPersonalEmail, parsePhoneValue } from "@/lib/phone-utils";
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
    const personalPhone =
      parsePhoneValue(co.personalPhone) ?? contact.personalPhone;
    const primaryEmail = personalEmail ?? contact.email;
    const primaryPhone = personalPhone ?? parsePhoneValue(contact.phone);

    if (
      personalEmail === contact.personalEmail &&
      personalPhone === contact.personalPhone &&
      primaryEmail === contact.email &&
      primaryPhone === contact.phone
    ) {
      continue;
    }

    await db
      .update(contacts)
      .set({
        workEmail: workEmail ?? co.workEmails[0] ?? null,
        personalEmail,
        personalPhone,
        email: primaryEmail,
        phone: primaryPhone,
        sourceProvider: "apollo+contactout",
      })
      .where(eq(contacts.id, contact.id));

    updated += 1;
    await new Promise((r) => setTimeout(r, 400));
  }

  return { updated, checked: withLinkedIn.length };
}
