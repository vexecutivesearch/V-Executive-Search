import { contactPhonesForDisplay, type SourcedPhone } from "@/lib/contact-phones";

/**
 * The number a sequence will text. Shared by enrollment, the day-0 text hold
 * and the phone backfill so a contact enriched after enroll resolves to the
 * same handle it would have got on day one.
 *
 * Company switchboards are excluded. `contacts.phone` falls back to the
 * company line when there is no direct dial, and `contacts.personal_phone`
 * takes any ContactOut number including a company one, so reading either
 * field directly can aim a personal-sounding text at a main office line —
 * and every contact at that company resolves to the same number, so they all
 * text the same switchboard. Everywhere else in the codebase treats
 * `kind !== "company"` as the definition of a direct phone; this agrees.
 */
export function pickPhone(contact: {
  personalPhone?: string | null;
  phone?: string | null;
  companyPhone?: string | null;
  phones?: SourcedPhone[] | null;
  sourceProvider?: string | null;
}): string | null {
  const direct = contactPhonesForDisplay(contact).filter(
    (p) => p.kind !== "company",
  );
  // ContactOut mobiles are the preferred cell source, then any other direct
  // number, matching the reveal waterfall's own ordering.
  return (
    direct.find((p) => p.source === "contactout" && p.kind === "mobile")
      ?.number ??
    direct.find((p) => p.kind === "mobile")?.number ??
    direct[0]?.number ??
    null
  );
}
