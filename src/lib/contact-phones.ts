import { parsePhoneValue, phoneDigits } from "@/lib/phone-utils";

export type PhoneSource = "apollo" | "contactout";
export type PhoneKind = "mobile" | "work" | "company" | "other";

export type SourcedPhone = {
  number: string;
  source: PhoneSource;
  kind?: PhoneKind;
};

export function phoneKindLabel(kind?: PhoneKind): string {
  if (kind === "mobile") return "Mobile";
  if (kind === "work") return "Work";
  if (kind === "company") return "Company line";
  return "Phone";
}

export function sourceLabel(source: PhoneSource): string {
  return source === "apollo" ? "Apollo" : "ContactOut";
}

function apolloTypeToKind(typeCd: string): PhoneKind {
  const t = typeCd.toLowerCase();
  if (t === "mobile" || t === "cell") return "mobile";
  if (t === "work" || t === "direct") return "work";
  if (t === "company" || t === "hq") return "company";
  return "other";
}

/** All phone numbers from an Apollo person payload (no org HQ fallback). */
export function extractApolloPhones(
  person: Record<string, unknown>,
): SourcedPhone[] {
  const out: SourcedPhone[] = [];
  const phones =
    (person.phone_numbers as Array<Record<string, string>>) ?? [];

  for (const entry of phones) {
    const number = parsePhoneValue(
      entry.sanitized_number || entry.raw_number || entry.number,
    );
    if (!number) continue;
    out.push({
      number,
      source: "apollo",
      kind: apolloTypeToKind(entry.type_cd || entry.type || "other"),
    });
  }

  // Some match responses expose a single mobile on the person root.
  for (const [field, kind] of [
    ["mobile_phone", "mobile"],
    ["phone", "mobile"],
    ["corporate_phone", "work"],
    ["direct_phone", "work"],
  ] as const) {
    const number = parsePhoneValue(String(person[field] ?? ""));
    if (number) {
      out.push({ number, source: "apollo", kind });
    }
  }

  return dedupeSourcedPhones(out);
}

/** All phone numbers from ContactOut API phone fields. */
export function extractContactOutPhones(raw: unknown[]): SourcedPhone[] {
  const out: SourcedPhone[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const number = parsePhoneValue(entry);
      if (number) {
        out.push({ number, source: "contactout", kind: "mobile" });
      }
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, string>;
    const number = parsePhoneValue(
      obj.number || obj.sanitized_number || obj.value || obj.phone,
    );
    if (!number) continue;
    const type = (obj.type || obj.label || "").toLowerCase();
    let kind: PhoneKind = "other";
    if (type.includes("mobile") || type.includes("cell") || type.includes("personal")) {
      kind = "mobile";
    } else if (type.includes("work")) {
      kind = "work";
    } else if (type.includes("company")) {
      kind = "company";
    }
    out.push({ number, source: "contactout", kind });
  }

  return dedupeSourcedPhones(out);
}

export function dedupeSourcedPhones(phones: SourcedPhone[]): SourcedPhone[] {
  const seen = new Set<string>();
  const out: SourcedPhone[] = [];
  for (const p of phones) {
    const number = parsePhoneValue(p.number);
    if (!number) continue;
    const key = `${p.source}:${phoneDigits(number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...p, number });
  }
  return out;
}

export function mergeSourcedPhones(
  ...groups: (SourcedPhone[] | null | undefined)[]
): SourcedPhone[] {
  return dedupeSourcedPhones(groups.flatMap((g) => g ?? []));
}

/** Prefer ContactOut mobile, then Apollo mobile; never auto-pick company lines as primary. */
export function pickPrimaryFromPhones(phones: SourcedPhone[]): {
  phone: string | null;
  personalPhone: string | null;
  companyPhone: string | null;
} {
  const contactOutMobile = phones.find(
    (p) => p.source === "contactout" && p.kind === "mobile",
  );
  const contactOutAny = phones.find((p) => p.source === "contactout");
  const apolloMobile = phones.find(
    (p) => p.source === "apollo" && p.kind === "mobile",
  );
  const apolloOther = phones.find(
    (p) => p.source === "apollo" && p.kind !== "company",
  );
  const companyLine = phones.find((p) => p.kind === "company");

  const personalPhone =
    contactOutMobile?.number ??
    contactOutAny?.number ??
    null;
  const phone =
    personalPhone ??
    apolloMobile?.number ??
    apolloOther?.number ??
    null;

  return {
    phone,
    personalPhone,
    companyPhone: companyLine?.number ?? null,
  };
}

/** Normalize legacy phone fields into a sourced phones list. */
export function syncContactPhoneFields(contact: {
  phones?: SourcedPhone[] | null;
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  sourceProvider?: string | null;
}): {
  phones: SourcedPhone[];
  phone: string | null;
  personalPhone: string | null;
  companyPhone: string | null;
} {
  const phones = contactPhonesForDisplay(contact);
  const primary = pickPrimaryFromPhones(phones);
  return {
    phones,
    phone: primary.phone,
    personalPhone: primary.personalPhone,
    companyPhone: primary.companyPhone,
  };
}

/** Hide shared company lines from primary dial when repeated across contacts. */
export function applySharedLineFilter<
  T extends { phones?: SourcedPhone[] | null } & {
    phone?: string | null;
    personalPhone?: string | null;
    companyPhone?: string | null;
    sourceProvider?: string | null;
  },
>(contacts: T[]): T[] {
  const normalized = contacts.map((c) => ({
    ...c,
    phones: contactPhonesForDisplay(c),
  }));

  const counts = new Map<string, number>();
  for (const c of normalized) {
    for (const p of c.phones) {
      const key = phoneDigits(p.number);
      if (key.length >= 10) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return normalized.map((c) => {
    const phones = c.phones.map((p) => {
      const key = phoneDigits(p.number);
      if (p.kind === "company" || (counts.get(key) ?? 0) >= 2) {
        return { ...p, kind: "company" as PhoneKind };
      }
      return p;
    });
    const primary = pickPrimaryFromPhones(phones);
    const sharedPrimary =
      primary.phone && (counts.get(phoneDigits(primary.phone)) ?? 0) >= 2;
    return {
      ...c,
      phones,
      phone: sharedPrimary && !primary.personalPhone ? null : primary.phone,
      personalPhone: primary.personalPhone,
      companyPhone: primary.companyPhone,
    };
  });
}

/** Build display list from phones json or legacy single fields. */
export function contactPhonesForDisplay(contact: {
  phones?: SourcedPhone[] | null;
  phone?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  sourceProvider?: string | null;
}): SourcedPhone[] {
  if (contact.phones?.length) {
    return contact.phones;
  }
  const legacy: SourcedPhone[] = [];
  if (contact.personalPhone) {
    legacy.push({
      number: contact.personalPhone,
      source: "contactout",
      kind: "mobile",
    });
  }
  if (contact.phone && contact.phone !== contact.personalPhone) {
    legacy.push({
      number: contact.phone,
      source: "apollo",
      kind: "mobile",
    });
  }
  if (contact.companyPhone) {
    legacy.push({
      number: contact.companyPhone,
      source: "apollo",
      kind: "company",
    });
  }
  return dedupeSourcedPhones(legacy);
}

export function sortPhonesForDisplay(phones: SourcedPhone[]): SourcedPhone[] {
  const rank = (p: SourcedPhone) => {
    const sourceRank = p.source === "contactout" ? 0 : 1;
    const kindRank =
      p.kind === "mobile" ? 0 : p.kind === "work" ? 1 : p.kind === "other" ? 2 : 3;
    return sourceRank * 10 + kindRank;
  };
  return [...phones].sort((a, b) => rank(a) - rank(b));
}
