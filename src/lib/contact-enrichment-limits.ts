import {
  contactPhonesForDisplay,
  MAX_PERSONAL_PHONES_PER_CONTACT,
  pickPrimaryFromPhones,
  trimPhonesForContact,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { isPersonalEmail } from "@/lib/phone-utils";

export type ContactOutEnrichNeeds = {
  needPersonalEmail: boolean;
  needWorkEmail: boolean;
  needPhone: boolean;
};

export function resolveWorkEmail(contact: {
  workEmail?: string | null;
  email?: string | null;
}): string | null {
  if (contact.workEmail?.trim()) return contact.workEmail.trim();
  if (contact.email && !isPersonalEmail(contact.email)) return contact.email.trim();
  return null;
}

export function resolvePersonalEmail(contact: {
  personalEmail?: string | null;
  email?: string | null;
}): string | null {
  if (contact.personalEmail?.trim()) return contact.personalEmail.trim();
  if (contact.email && isPersonalEmail(contact.email)) return contact.email.trim();
  return null;
}

export function directPhoneCount(contact: {
  phones?: SourcedPhone[] | null;
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  sourceProvider?: string | null;
}): number {
  return contactPhonesForDisplay(contact).filter((p) => p.kind !== "company").length;
}

export function contactNeedsContactOutEnrichment(contact: {
  workEmail?: string | null;
  personalEmail?: string | null;
  email?: string | null;
  phones?: SourcedPhone[] | null;
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  sourceProvider?: string | null;
}): boolean {
  const needs = getContactOutEnrichNeeds(contact);
  return needs.needPersonalEmail || needs.needWorkEmail || needs.needPhone;
}

export function getContactOutEnrichNeeds(contact: {
  workEmail?: string | null;
  personalEmail?: string | null;
  email?: string | null;
  phones?: SourcedPhone[] | null;
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  sourceProvider?: string | null;
}): ContactOutEnrichNeeds {
  return {
    needPersonalEmail: !resolvePersonalEmail(contact),
    needWorkEmail: !resolveWorkEmail(contact),
    needPhone: directPhoneCount(contact) < MAX_PERSONAL_PHONES_PER_CONTACT,
  };
}

export function pickWorkEmail(candidates: string[]): string | null {
  for (const raw of candidates) {
    const email = raw?.trim();
    if (email && !isPersonalEmail(email)) return email;
  }
  return null;
}

export function pickPersonalEmailFromList(candidates: string[]): string | null {
  for (const raw of candidates) {
    const email = raw?.trim();
    if (email && isPersonalEmail(email)) return email;
  }
  return null;
}

/** One work email, one personal email, max 3 direct phones — nothing extra stored. */
export function normalizeContactChannels(input: {
  workEmail?: string | null;
  personalEmail?: string | null;
  email?: string | null;
  phones?: SourcedPhone[] | null;
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  sourceProvider?: string | null;
}): {
  workEmail: string | null;
  personalEmail: string | null;
  email: string | null;
  phones: SourcedPhone[];
  phone: string | null;
  personalPhone: string | null;
  companyPhone: string | null;
} {
  const personalEmail =
    pickPersonalEmailFromList([
      input.personalEmail ?? "",
      input.email ?? "",
    ]) ?? null;
  const workEmail =
    pickWorkEmail([input.workEmail ?? "", input.email ?? ""]) ?? null;

  const phones = trimPhonesForContact(contactPhonesForDisplay(input));
  const primary = pickPrimaryFromPhones(phones);

  return {
    workEmail,
    personalEmail,
    email: personalEmail ?? workEmail,
    phones,
    phone: primary.phone,
    personalPhone: primary.personalPhone,
    companyPhone: primary.companyPhone,
  };
}
