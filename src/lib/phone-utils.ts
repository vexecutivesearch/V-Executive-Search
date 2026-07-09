/** Normalize phone for dedupe comparisons. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Parse Apollo JSON phone blobs or plain strings. */
export function parsePhoneValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, string>;
      return (
        obj.sanitized_number ||
        obj.number ||
        obj.raw_number ||
        null
      );
    } catch {
      return null;
    }
  }

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
