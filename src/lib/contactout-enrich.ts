import { isPersonalEmail } from "@/lib/phone-utils";
import {
  extractContactOutPhones,
  mergeSourcedPhones,
  type SourcedPhone,
} from "@/lib/contact-phones";
import {
  pickPersonalEmailFromList,
  pickWorkEmail,
} from "@/lib/contact-enrichment-limits";
import { isContactOutSampleResponse } from "@/lib/contactout-samples";
import {
  assertPaidEgressAllowed,
  recordProviderUsageEvent,
  type PaidEgressContext,
} from "@/lib/paid-egress";

const CONTACTOUT_LINKEDIN_URL = "https://api.contactout.com/v1/people/linkedin";

export type ContactOutData = {
  personalEmail: string | null;
  /** Top personal emails ContactOut found (up to 2), best first. */
  personalEmails: string[];
  workEmail: string | null;
  personalPhone: string | null;
  phones: SourcedPhone[];
  phoneApiLocked: boolean;
};

export type ContactOutEnrichOptions = {
  needPersonalEmail?: boolean;
  needWorkEmail?: boolean;
  needPhone?: boolean;
};

function normalizeLinkedIn(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("http")) return trimmed;
  return `https://www.linkedin.com/in/${trimmed.replace(/^\/+/, "")}`;
}

/** All personal emails ContactOut returned, personal-domain ones first. */
function collectPersonalEmails(emails: unknown[], max = 2): string[] {
  const found: string[] = [];
  const push = (email: string | null | undefined) => {
    const e = email?.trim();
    if (e && isPersonalEmail(e) && !found.includes(e)) found.push(e);
  };
  for (const entry of emails) {
    if (typeof entry === "string") {
      push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, string>;
    push(obj.email || obj.value || obj.address);
  }
  return found.slice(0, max);
}

function pickPersonalEmail(emails: unknown[]): string | null {
  const strings: string[] = [];
  for (const entry of emails) {
    if (typeof entry === "string") {
      strings.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, string>;
    const email = obj.email || obj.value || obj.address;
    if (!email) continue;
    const type = (obj.type || obj.label || "").toLowerCase();
    if (type.includes("personal") || isPersonalEmail(email)) {
      return email;
    }
    strings.push(email);
  }
  return pickPersonalEmailFromList(strings);
}

function collectProfileLists(
  profile: Record<string, unknown>,
  keys: string[],
): unknown[] {
  const out: unknown[] = [];
  for (const key of keys) {
    const val = profile[key];
    if (Array.isArray(val)) out.push(...val);
    else if (typeof val === "string" && val) out.push(val);
  }
  return out;
}

function parseContactOutPayload(data: Record<string, unknown>): ContactOutData {
  if (isContactOutSampleResponse(data)) {
    return {
      personalEmail: null,
      personalEmails: [],
      workEmail: null,
      personalPhone: null,
      phones: [],
      phoneApiLocked: true,
    };
  }

  const profile = (data.profile ?? data.data ?? data) as Record<string, unknown>;
  const emailsRaw = collectProfileLists(profile, [
    "personal_email",
    "personal_emails",
    "emails",
    "email",
  ]);
  const phonesRaw = collectProfileLists(profile, [
    "phone",
    "phones",
    "mobile",
    "personal_phone",
  ]);
  const workEmailsRaw = collectProfileLists(profile, [
    "work_email",
    "work_emails",
  ]).map(String);

  const phones = extractContactOutPhones(phonesRaw);
  const personalPhone =
    phones.find((p) => p.kind === "mobile")?.number ?? phones[0]?.number ?? null;

  const personalEmails = collectPersonalEmails(emailsRaw, 2);
  return {
    personalEmail: pickPersonalEmail(emailsRaw) ?? personalEmails[0] ?? null,
    personalEmails,
    workEmail: pickWorkEmail(workEmailsRaw),
    personalPhone,
    phones,
    phoneApiLocked: false,
  };
}

function mergeContactOutData(
  base: ContactOutData,
  phones: ContactOutData,
): ContactOutData {
  return {
    personalEmail: base.personalEmail ?? phones.personalEmail,
    personalEmails: [
      ...new Set([...base.personalEmails, ...phones.personalEmails]),
    ].slice(0, 2),
    workEmail: base.workEmail ?? phones.workEmail,
    personalPhone: phones.personalPhone ?? base.personalPhone,
    phones: mergeSourcedPhones(base.phones, phones.phones),
    phoneApiLocked: base.phoneApiLocked || phones.phoneApiLocked,
  };
}

async function contactOutGet(
  apiKey: string,
  params: Record<string, string>,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<Record<string, unknown> | null> {
  await assertPaidEgressAllowed("contactout", "people/linkedin", context, {
    companyId,
    estimatedCost: 1,
    metadata: { params },
  });
  const resp = await fetch(
    `${CONTACTOUT_LINKEDIN_URL}?${new URLSearchParams(params)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        token: apiKey,
      },
    },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) return null;
  const data = (await resp.json()) as Record<string, unknown>;
  await recordProviderUsageEvent("contactout", "people/linkedin", context ?? "automated_scrape", {
    companyId,
    recordsReturned: data ? 1 : 0,
    estimatedCost: 1,
    metadata: { params },
  });
  return data;
}

export async function enrichFromContactOut(
  linkedinUrl: string,
  apiKey: string,
  options: ContactOutEnrichOptions = {},
  context?: PaidEgressContext,
  companyId?: string,
): Promise<ContactOutData | null> {
  const needPersonalEmail = options.needPersonalEmail ?? true;
  const needWorkEmail = options.needWorkEmail ?? true;
  const needPhone = options.needPhone ?? true;

  if (!needPersonalEmail && !needWorkEmail && !needPhone) {
    return null;
  }

  const profile = normalizeLinkedIn(linkedinUrl);
  let base: ContactOutData | null = null;

  if (needPersonalEmail || needWorkEmail) {
    const emailTypes: string[] = [];
    if (needPersonalEmail) emailTypes.push("personal");
    if (needWorkEmail) emailTypes.push("work");
    const emailData = await contactOutGet(apiKey, {
      profile,
      email_type: emailTypes.join(","),
    }, context, companyId);
    if (emailData) {
      base = parseContactOutPayload(emailData);
      if (base.phoneApiLocked) return base;
    } else if (!needPhone) {
      // Email miss and no phone wanted — nothing left to fetch.
      return null;
    }
    // Email miss must NOT abort the phone lookup: ContactOut frequently has
    // a mobile for a person it has no email for.
  }

  if (!needPhone) {
    if (base?.personalEmail || base?.workEmail) return base;
    return null;
  }

  const phoneData = await contactOutGet(apiKey, {
    profile,
    include_phone: "true",
    email_type: "none",
  }, context, companyId);
  if (!phoneData) {
    if (base?.personalEmail || base?.workEmail) return base;
    return null;
  }

  const phoneResult = parseContactOutPayload(phoneData);
  if (phoneResult.phoneApiLocked) {
    if (base?.personalEmail || base?.workEmail) {
      return { ...base, phoneApiLocked: true };
    }
    return phoneResult;
  }

  const merged = base
    ? mergeContactOutData(base, phoneResult)
    : phoneResult;

  if (merged.personalEmail || merged.workEmail || merged.phones.length) {
    return merged;
  }
  return null;
}

// Re-export for apollo-enrich company-level dedupe
export { applySharedLineFilter as dedupeCompanyPhones } from "@/lib/contact-phones";
