import {
  isPersonalEmail,
  parsePhoneValue,
  phoneDigits,
} from "@/lib/phone-utils";

const CONTACTOUT_PROFILE_URL = "https://api.contactout.com/v2/enrich/profile";
const CONTACTOUT_LINKEDIN_URL = "https://api.contactout.com/v1/people/linkedin";

export type ContactOutData = {
  personalEmail: string | null;
  personalPhone: string | null;
  workEmails: string[];
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

function pickMobilePhone(phones: unknown[]): string | null {
  for (const entry of phones) {
    if (typeof entry === "string") return parsePhoneValue(entry);
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, string>;
    const type = (obj.type || obj.label || "").toLowerCase();
    const number = obj.number || obj.sanitized_number || obj.value || obj.phone;
    if (!number) continue;
    if (type.includes("mobile") || type.includes("cell") || type.includes("personal")) {
      return parsePhoneValue(number);
    }
  }
  for (const entry of phones) {
    if (typeof entry === "string") return parsePhoneValue(entry);
    if (entry && typeof entry === "object") {
      const number = (entry as Record<string, string>).number;
      if (number) return parsePhoneValue(number);
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

  return {
    personalEmail: pickPersonalEmail(emailsRaw),
    personalPhone: pickMobilePhone(phonesRaw),
    workEmails,
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
      if (resp.status === 404) {
        return { personalEmail: null, personalPhone: null, workEmails: [] };
      }
      if (!resp.ok) continue;
      const data = (await resp.json()) as Record<string, unknown>;
      const parsed = parseContactOutPayload(data);
      if (
        parsed.personalEmail ||
        parsed.personalPhone ||
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

export function dedupeCompanyPhones<
  T extends {
    phone?: string | null;
    personalPhone?: string | null;
    companyPhone?: string | null;
  },
>(contacts: T[]): T[] {
  const counts = new Map<string, number>();
  for (const c of contacts) {
    for (const field of [c.personalPhone, c.phone, c.companyPhone]) {
      const parsed = parsePhoneValue(field);
      if (!parsed) continue;
      const key = phoneDigits(parsed);
      if (key.length >= 10) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return contacts.map((c) => {
    const personal = parsePhoneValue(c.personalPhone);
    const direct = parsePhoneValue(c.phone);
    let best = personal ?? direct;
    if (best && !personal) {
      const key = phoneDigits(best);
      if ((counts.get(key) ?? 0) >= 2) {
        return { ...c, phone: null, companyPhone: direct ?? c.companyPhone };
      }
    }
    return { ...c, phone: best ?? null };
  });
}
