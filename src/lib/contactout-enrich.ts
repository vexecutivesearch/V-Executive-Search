import { isPersonalEmail } from "@/lib/phone-utils";
import {
  extractContactOutPhones,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { isContactOutSampleResponse } from "@/lib/contactout-samples";

const CONTACTOUT_LINKEDIN_URL = "https://api.contactout.com/v1/people/linkedin";

export type ContactOutData = {
  personalEmail: string | null;
  personalPhone: string | null;
  workEmails: string[];
  phones: SourcedPhone[];
  phoneApiLocked: boolean;
};

function normalizeLinkedIn(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("http")) return trimmed;
  return `https://www.linkedin.com/in/${trimmed.replace(/^\/+/, "")}`;
}

function pickPersonalEmail(emails: unknown[]): string | null {
  for (const entry of emails) {
    if (typeof entry === "string") {
      if (isPersonalEmail(entry)) return entry;
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, string>;
    const email = obj.email || obj.value || obj.address;
    if (!email) continue;
    const type = (obj.type || obj.label || "").toLowerCase();
    if (type.includes("personal") || isPersonalEmail(email)) return email;
  }
  for (const entry of emails) {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
      const email = (entry as Record<string, string>).email;
      if (email) return email;
    }
  }
  return null;
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
      personalPhone: null,
      workEmails: [],
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
  const workEmails = collectProfileLists(profile, [
    "work_email",
    "work_emails",
  ]).map(String);

  const phones = extractContactOutPhones(phonesRaw);
  const personalPhone =
    phones.find((p) => p.kind === "mobile")?.number ?? phones[0]?.number ?? null;

  return {
    personalEmail: pickPersonalEmail(emailsRaw),
    personalPhone,
    workEmails,
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
    personalPhone: phones.personalPhone ?? base.personalPhone,
    workEmails: base.workEmails.length ? base.workEmails : phones.workEmails,
    phones: [...base.phones, ...phones.phones],
    phoneApiLocked: base.phoneApiLocked || phones.phoneApiLocked,
  };
}

async function contactOutGet(
  apiKey: string,
  params: Record<string, string>,
): Promise<Record<string, unknown> | null> {
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
  return (await resp.json()) as Record<string, unknown>;
}

export async function enrichFromContactOut(
  linkedinUrl: string,
  apiKey: string,
): Promise<ContactOutData | null> {
  const profile = normalizeLinkedIn(linkedinUrl);

  const emailData = await contactOutGet(apiKey, {
    profile,
    email_type: "personal,work",
  });
  if (!emailData) return null;

  const base = parseContactOutPayload(emailData);
  if (base.phoneApiLocked) return null;

  const phoneData = await contactOutGet(apiKey, {
    profile,
    include_phone: "true",
    email_type: "none",
  });
  if (!phoneData) {
    if (base.personalEmail || base.workEmails.length) return base;
    return null;
  }

  const phoneResult = parseContactOutPayload(phoneData);
  if (phoneResult.phoneApiLocked) {
    return base.personalEmail || base.workEmails.length ? base : null;
  }

  const merged = mergeContactOutData(base, phoneResult);
  if (merged.personalEmail || merged.phones.length || merged.workEmails.length) {
    return merged;
  }
  return null;
}

// Re-export for apollo-enrich company-level dedupe
export { applySharedLineFilter as dedupeCompanyPhones } from "@/lib/contact-phones";
