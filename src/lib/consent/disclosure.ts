/**
 * The exact words shown next to the consent checkbox.
 *
 * Under the TCPA, SMS marketing to a mobile needs express written consent, and
 * the one mechanism that is not on unsettled legal ground is an E-SIGN
 * compliant web form: an unchecked box the visitor is not required to tick,
 * next to full disclosure. A2P 10DLC carrier review additionally requires the
 * business name, message frequency, the rates notice, and the HELP/STOP line
 * to be visible at the point of opt-in.
 *
 * The wording is versioned and resolved SERVER-SIDE. The submitted form sends
 * only a version tag; the endpoint stores the text this module produces for
 * that tag. A client-supplied disclosure string would be worth nothing as
 * evidence, because the submitter would control it.
 */

export const CONSENT_DISCLOSURE_VERSION = "sms-web-form-2026-08";

/** Overridable so the operator can rebrand without a code change. */
export function consentBusinessName(): string {
  return process.env.CONSENT_BUSINESS_NAME?.trim() || "V Executive Search";
}

export type DisclosureCopy = {
  version: string;
  businessName: string;
  /** Verbatim text stored on the consent record. */
  text: string;
  privacyUrl: string;
  termsUrl: string;
};

const PRIVACY_PATH = "/privacy";
const TERMS_PATH = "/terms";

function disclosureText(businessName: string): string {
  return [
    `By checking this box, I agree that ${businessName} may send me recurring text`,
    "messages about my hiring needs at the mobile number I provided. Message",
    "frequency varies and is typically no more than 4 messages per month. Msg and",
    "data rates may apply. Consent is not required to receive a call, an email, or",
    "any of our services. Reply HELP for help and STOP to opt out at any time. Our",
    `Privacy Policy (${PRIVACY_PATH}) and Terms of Service (${TERMS_PATH}) explain how`,
    `${businessName} handles this information.`,
  ].join(" ");
}

/** The copy for a version tag, or null when the tag is not one we published. */
export function disclosureForVersion(
  version: string,
  businessName = consentBusinessName(),
): DisclosureCopy | null {
  if (version !== CONSENT_DISCLOSURE_VERSION) return null;
  return {
    version,
    businessName,
    text: disclosureText(businessName),
    privacyUrl: PRIVACY_PATH,
    termsUrl: TERMS_PATH,
  };
}

export function currentDisclosure(
  businessName = consentBusinessName(),
): DisclosureCopy {
  return disclosureForVersion(CONSENT_DISCLOSURE_VERSION, businessName)!;
}
