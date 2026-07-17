/** Normalize phone for dedupe comparisons. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * A dialable phone must have enough digits to be a real number. Short codes
 * / hotlines like "16224" (Egyptian corporate line Apollo sometimes returns
 * as corporate_phone) are not callable leads and must be rejected.
 * US/international direct numbers have >= 10 significant digits (7 local +
 * area/country); we accept >= 8 to be safe for a few short national formats.
 */
const MIN_PHONE_DIGITS = 8;

export function isDialablePhone(value: string | null | undefined): boolean {
  if (!value) return false;
  return phoneDigits(value).length >= MIN_PHONE_DIGITS;
}

/** Parse Apollo JSON phone blobs, nested objects, or plain strings. */
export function parsePhoneValue(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return (
      parsePhoneValue(obj.sanitized_number) ??
      parsePhoneValue(obj.number) ??
      parsePhoneValue(obj.raw_number)
    );
  }
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[object Object]") return null;

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, string>;
      const value =
        obj.sanitized_number || obj.number || obj.raw_number || null;
      return value && isDialablePhone(value) ? value : null;
    } catch {
      return null;
    }
  }

  // Reject short codes / hotlines that can't be dialed as a real lead.
  if (!isDialablePhone(trimmed)) return null;
  return trimmed;
}

export function isPersonalEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const personalDomains = [
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "me.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
  ];
  return personalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export type ContactPhoneFields = {
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
};

/** Drop shared company lines; prefer personal mobile for display/dial. */
export function applyCompanyPhoneDedupe<
  T extends ContactPhoneFields & { id?: string },
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
    const company = parsePhoneValue(c.companyPhone);

    let best = personal ?? direct;
    if (best) {
      const key = phoneDigits(best);
      if (counts.get(key)! >= 2 && !personal) {
        best = null;
      }
    }

    return {
      ...c,
      phone: best,
      companyPhone:
        company ??
        (direct && counts.get(phoneDigits(direct))! >= 2 ? direct : c.companyPhone),
    };
  });
}

export function bestDialPhone(contact: ContactPhoneFields): string | null {
  return (
    parsePhoneValue(contact.personalPhone) ??
    parsePhoneValue(contact.phone) ??
    null
  );
}
