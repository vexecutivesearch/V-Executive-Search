import { isPersonalEmail } from "@/lib/phone-utils";
import {
  extractContactOutPhones,
  type SourcedPhone,
} from "@/lib/contact-phones";

const CONTACTOUT_PROFILE_URL = "https://api.contactout.com/v2/enrich/profile";
const CONTACTOUT_LINKEDIN_URL = "https://api.contactout.com/v1/people/linkedin";

export type ContactOutData = {
  personalEmail: string | null;
  personalPhone: string | null;
  workEmails: string[];
  phones: SourcedPhone[];
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

function parseContactOutPayload(data: Record<string, unknown>): ContactOutData {
  const profile = (data.profile ?? data.data ?? data) as Record<string, unknown>;
  const emailsRaw: unknown[] = [];
  for (const key of ["personal_email", "personal_emails", "emails", "email"]) {
    const val = profile[key];
    if (Array.isArray(val)) emailsRaw.push(...val);
    else if (typeof val === "string" && val) emailsRaw.push(val);
  }

  const phonesRaw: unknown[] = [];
  for (const key of ["phone", "phones", "mobile", "personal_phone"]) {
    const val = profile[key];
    if (Array.isArray(val)) phonesRaw.push(...val);
    else if (typeof val === "string" && val) phonesRaw.push(val);
  }

  const workEmails: string[] = [];
  for (const key of ["work_email", "work_emails"]) {
    const val = profile[key];
    if (Array.isArray(val)) workEmails.push(...val.map(String));
    else if (typeof val === "string" && val) workEmails.push(val);
  }

  const phones = extractContactOutPhones(phonesRaw);
  const personalPhone =
    phones.find((p) => p.kind === "mobile")?.number ?? phones[0]?.number ?? null;

  return {
    personalEmail: pickPersonalEmail(emailsRaw),
    personalPhone,
    workEmails,
    phones,
  };
}

export async function enrichFromContactOut(
  linkedinUrl: string,
  apiKey: string,
): Promise<ContactOutData | null> {
  const profile = normalizeLinkedIn(linkedinUrl);
  const attempts: Array<{
    endpoint: string;
    method: "get" | "post";
    params: Record<string, string>;
  }> = [
    {
      endpoint: CONTACTOUT_LINKEDIN_URL,
      method: "get",
      params: { profile, include: "personal_email,phone" },
    },
    {
      endpoint: CONTACTOUT_PROFILE_URL,
      method: "post",
      params: { profile, include: "personal_email,phone" },
    },
  ];

  for (const { endpoint, method, params } of attempts) {
    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        token: apiKey,
      };
      const resp =
        method === "get"
          ? await fetch(`${endpoint}?${new URLSearchParams(params)}`, {
              method: "GET",
              headers,
            })
          : await fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(params),
            });
      if (resp.status === 404) continue;
      if (!resp.ok) continue;
      const data = (await resp.json()) as Record<string, unknown>;
      const parsed = parseContactOutPayload(data);
      if (
        parsed.personalEmail ||
        parsed.phones.length ||
        parsed.workEmails.length
      ) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// Re-export for apollo-enrich company-level dedupe
export { applySharedLineFilter as dedupeCompanyPhones } from "@/lib/contact-phones";
