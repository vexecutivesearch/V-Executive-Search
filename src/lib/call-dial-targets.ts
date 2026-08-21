import {
  contactPhonesForDisplay,
  phoneKindLabel,
  type SourcedPhone,
} from "@/lib/contact-phones";
import {
  classifyContactPhones,
  companyMainLine,
  dialGate,
  type PhoneClassification,
} from "@/lib/phone-classification";
import { phoneDigits } from "@/lib/phone-utils";

/**
 * Every number the call screen may show, each already through the dial gate.
 *
 * Building the list and gating it in the same pass is deliberate: a UI that
 * renders numbers from one source and asks a gate about them separately can
 * drift, and the drift is a mobile with a live tel: link. Both the call screen
 * and the outcome endpoint read this list, so the client and the server agree
 * on what was dialable.
 */

export type DialTarget = {
  number: string;
  label: string;
  classification: PhoneClassification;
  allowed: boolean;
  /** Why it cannot be dialed; null when it can. */
  reason: string | null;
  contactId: string | null;
};

type ContactLike = {
  id: string;
  name?: string | null;
  phones?: SourcedPhone[] | null;
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  sourceProvider?: string | null;
  phoneClassification?: PhoneClassification | null;
};

type CompanyLike = {
  name?: string | null;
  phone?: string | null;
  phoneClassification?: PhoneClassification | null;
};

function toTarget(
  phone: SourcedPhone,
  label: string,
  contactId: string | null,
): DialTarget | null {
  const gate = dialGate(phone);
  const number = gate.number;
  if (!number) return null;
  return {
    number,
    label,
    classification: gate.classification,
    allowed: gate.allowed,
    reason: gate.allowed ? null : gate.reason,
    contactId,
  };
}

/**
 * Company main line first — it is the only number a cold call may use — then
 * the contact numbers, which are shown so the operator can see they exist and
 * why they are blocked.
 */
export function buildDialTargets(input: {
  company: CompanyLike;
  contacts?: ContactLike[];
}): DialTarget[] {
  const targets: DialTarget[] = [];

  const mainLine = companyMainLine(input.company);
  if (mainLine) {
    const label = input.company.name
      ? `Main line · ${input.company.name}`
      : "Main line";
    const target = toTarget(mainLine, label, null);
    if (target) targets.push(target);
  }

  for (const contact of input.contacts ?? []) {
    const stored = contact.phones?.length
      ? contact.phones
      : contactPhonesForDisplay(contact);
    const classified = classifyContactPhones({
      phones: stored,
      phoneClassification: contact.phoneClassification ?? null,
    });
    for (const phone of classified) {
      const who = contact.name?.trim() || "Contact";
      const target = toTarget(
        phone,
        `${who} · ${phoneKindLabel(phone.kind)}`,
        contact.id,
      );
      if (target) targets.push(target);
    }
  }

  const seen = new Set<string>();
  const deduped: DialTarget[] = [];
  for (const target of targets) {
    const key = phoneDigits(target.number);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }

  return [
    ...deduped.filter((t) => t.allowed),
    ...deduped.filter((t) => !t.allowed),
  ];
}

/** The gated target for a number, matched on digits. */
export function findDialTarget(
  targets: DialTarget[],
  phone: string | null | undefined,
): DialTarget | null {
  const digits = phoneDigits(phone ?? "");
  if (digits.length < 8) return null;
  return (
    targets.find((target) => phoneDigits(target.number) === digits) ?? null
  );
}

export function dialableTargets(targets: DialTarget[]): DialTarget[] {
  return targets.filter((target) => target.allowed);
}
