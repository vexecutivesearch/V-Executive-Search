import { appBaseUrl } from "@/lib/outreach/unsubscribe";

/**
 * The opt-in form URL emailed from the call screen.
 *
 * This is what replaces a press-1 IVR. Consent captured by keypress or voice
 * recording sits on unsettled ground — E-SIGN 7001(c)(6) excludes recordings
 * of oral communications, and the Fifth Circuit split from the FCC on it in
 * Feb 2026 — so the call's job is to earn a click on a written form, and the
 * form is the only thing that captures consent.
 */

export const OPT_IN_PATH = "/opt-in";

/** `src` rides through to the consent record's source identifier. */
export function optInFormUrl(source?: string | null): string | null {
  const base = appBaseUrl();
  if (!base) return null;
  const url = `${base}${OPT_IN_PATH}`;
  return source ? `${url}?src=${encodeURIComponent(source)}` : url;
}

export function optInEmailSubject(businessName: string): string {
  return `${businessName} — the link I mentioned`;
}

/**
 * Plain text, matching the rest of our sends: no HTML part, no tracking.
 * Short and about the form — the recipient just spoke to a human.
 */
export function optInEmailText(options: {
  contactName?: string | null;
  senderName: string;
  businessName: string;
  formUrl: string;
}): string {
  const first = options.contactName?.trim().split(/\s+/)[0];
  return [
    first ? `Hi ${first},` : "Hi,",
    "",
    "Thanks for taking my call. Here is the short form I mentioned — it takes a",
    "minute and tells us what you're hiring for:",
    "",
    options.formUrl,
    "",
    "If you'd like text updates on candidates, there's an optional box on the",
    "form. It's optional, and leaving it unticked changes nothing else.",
    "",
    "Best regards,",
    "",
    options.senderName,
    options.businessName,
  ].join("\n");
}
