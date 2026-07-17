import { isPersonalEmail } from "@/lib/phone-utils";

/** Resolve the best work email for a contact (dedicated field, else non-personal primary). */
export function resolveWorkEmail(contact: {
  workEmail?: string | null;
  email?: string | null;
}): string | null {
  if (contact.workEmail?.trim()) return contact.workEmail.trim();
  if (contact.email && !isPersonalEmail(contact.email)) return contact.email.trim();
  return null;
}

/** Resolve the best personal email for a contact (dedicated field, else personal primary). */
export function resolvePersonalEmail(contact: {
  personalEmail?: string | null;
  email?: string | null;
}): string | null {
  if (contact.personalEmail?.trim()) return contact.personalEmail.trim();
  if (contact.email && isPersonalEmail(contact.email)) return contact.email.trim();
  return null;
}
