import type { SourcedPhone } from "@/lib/contact-phones";

/**
 * The number a sequence will text. Shared by enrollment and the phone
 * backfill so a contact enriched after enroll resolves to the same handle it
 * would have got on day one.
 */
export function pickPhone(contact: {
  personalPhone?: string | null;
  phone?: string | null;
  phones?: SourcedPhone[] | null;
}): string | null {
  return (
    contact.personalPhone?.trim() ||
    contact.phone?.trim() ||
    (contact.phones ?? []).find((p) => p.kind === "mobile")?.number ||
    null
  );
}
