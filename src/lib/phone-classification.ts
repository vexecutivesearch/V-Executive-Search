import {
  deriveClassification,
  type PhoneClassification,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { isDialablePhone, parsePhoneValue } from "@/lib/phone-utils";

/**
 * Dial safety for human calling.
 *
 * FTC TSR 16 CFR 310.6(b)(7) exempts B2B calls from the DNC registry, so no
 * DNC subscription is needed. TCPA restrictions attach instead to the number
 * type and the technology used: prerecorded/AI voice and autodialers to
 * wireless numbers are restricted regardless of business purpose. A human
 * manually dialing a business landline engages none of them.
 *
 * So the only number this system will let anyone dial is one positively known
 * to be a business line. `unknown` is treated exactly like `mobile`: absence
 * of evidence is not evidence of a landline.
 */

export type { PhoneClassification };

/** Anything carrying enough of a SourcedPhone to be classified. */
export type PhoneLike = {
  number?: string | null;
  source?: SourcedPhone["source"];
  kind?: SourcedPhone["kind"];
  classification?: PhoneClassification;
};

/** Only class that may be dialed. Everything else is blocked, not warned. */
export const DIALABLE_CLASSIFICATION = "business_line" as const;

export const PHONE_CLASSIFICATION_LABELS: Record<PhoneClassification, string> = {
  business_line: "Business line",
  mobile: "Mobile",
  unknown: "Unclassified",
};

/**
 * Why a number cannot be dialed, in the operator's terms. `unknown` and
 * `mobile` deliberately give the same account of the rule.
 */
export const BLOCKED_DIAL_REASONS: Record<PhoneClassification, string | null> = {
  business_line: null,
  mobile:
    "Mobile number — calling it is not gated by the B2B DNC exemption the way a business line is. Email the opt-in link instead.",
  unknown:
    "Number type is unverified, and an unverified number is treated as a mobile. Email the opt-in link instead.",
};

/** The stored class, or the provenance derivation for rows predating it. */
export function classifySourcedPhone(phone: PhoneLike): PhoneClassification {
  if (phone.classification) return phone.classification;
  if (!phone.source) return phone.kind === "company" ? "business_line" : "unknown";
  return deriveClassification(phone.source, phone.kind);
}

/** Stamp the derived class onto phones that predate the column. */
export function withClassification(phone: SourcedPhone): SourcedPhone {
  return { ...phone, classification: classifySourcedPhone(phone) };
}

export function classifySourcedPhones(phones: SourcedPhone[]): SourcedPhone[] {
  return phones.map(withClassification);
}

export type DialGate =
  | { allowed: true; number: string; classification: "business_line" }
  | {
      allowed: false;
      number: string | null;
      classification: PhoneClassification;
      reason: string;
    };

/**
 * The single gate every dial affordance must pass through. There is no
 * override argument on purpose — an unsafe dial should be unreachable, not
 * confirmable.
 */
export function dialGate(phone: PhoneLike | null | undefined): DialGate {
  const number = parsePhoneValue(phone?.number ?? null);
  if (!phone || !number || !isDialablePhone(number)) {
    return {
      allowed: false,
      number: null,
      classification: "unknown",
      reason: "No dialable number on file.",
    };
  }

  const classification = classifySourcedPhone(phone);
  if (classification === DIALABLE_CLASSIFICATION) {
    return { allowed: true, number, classification };
  }
  return {
    allowed: false,
    number,
    classification,
    reason: BLOCKED_DIAL_REASONS[classification]!,
  };
}

/** True only for a number positively known to be a business line. */
export function canDial(phone: PhoneLike | null | undefined): boolean {
  return dialGate(phone).allowed;
}

/**
 * The company main line as a classified phone. `companies.phone` is written
 * only by Apollo organization search, which returns the published main line.
 */
export function companyMainLine(
  company: {
    phone?: string | null;
    phoneClassification?: PhoneClassification | null;
  } | null,
): SourcedPhone | null {
  const number = parsePhoneValue(company?.phone ?? null);
  if (!number) return null;
  return {
    number,
    source: "apollo",
    kind: "company",
    classification: company?.phoneClassification ?? "business_line",
  };
}

/**
 * Backfill classes for a contact's stored numbers. ContactOut numbers are
 * personal mobiles; a shared company line keeps its business_line class.
 */
export function classifyContactPhones(contact: {
  phones?: SourcedPhone[] | null;
  phoneClassification?: PhoneClassification | null;
}): SourcedPhone[] {
  const stored = contact.phones ?? [];
  return stored.map((phone) => {
    if (phone.classification) return phone;
    if (phone.kind === "company") {
      return { ...phone, classification: "business_line" as const };
    }
    // A contact-level class set by enrichment wins over the generic
    // derivation, but never upgrades a number to dialable.
    const contactClass = contact.phoneClassification;
    if (contactClass && contactClass !== "business_line") {
      return { ...phone, classification: contactClass };
    }
    return withClassification(phone);
  });
}
