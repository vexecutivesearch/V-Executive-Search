import {
  extractContactOutPhones,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { isPersonalEmail } from "@/lib/phone-utils";
import { isContactOutSampleResponse } from "@/lib/contactout-samples";

const CONTACTOUT_SEARCH_URL = "https://api.contactout.com/v1/people/search";

export type ContactOutDomainPerson = {
  name: string;
  title: string;
  linkedinUrl: string;
  workEmail: string | null;
  personalEmail: string | null;
  phone: string | null;
  personalPhone: string | null;
  phones: SourcedPhone[];
};

const TITLE_RANK: Array<[string, number]> = [
  ["owner", 0],
  ["founder", 1],
  ["president", 2],
  ["ceo", 3],
  ["chief", 4],
  ["general manager", 5],
  ["office manager", 6],
  ["practice manager", 7],
  ["hr ", 8],
  ["human resources", 8],
  ["director", 9],
  ["manager", 10],
  ["supervisor", 11],
];

function titleRank(title: string): number {
  const lower = title.toLowerCase();
  for (const [keyword, rank] of TITLE_RANK) {
    if (lower.includes(keyword)) return rank;
  }
  return 50;
}

function parseProfile(
  linkedinUrl: string,
  profile: Record<string, unknown>,
): ContactOutDomainPerson | null {
  const name = String(profile.full_name ?? "").trim();
  const title = String(profile.title ?? profile.headline ?? "").trim();
  if (!name) return null;

  const contactInfo = (profile.contact_info ?? {}) as Record<string, unknown>;
  const workEmails = (contactInfo.work_emails as string[] | undefined) ?? [];
  const personalEmails =
    (contactInfo.personal_emails as string[] | undefined) ?? [];
  const rawEmails = (contactInfo.emails as string[] | undefined) ?? [];

  let workEmail = workEmails[0] ?? null;
  let personalEmail = personalEmails[0] ?? null;
  for (const email of rawEmails) {
    if (!email) continue;
    if (isPersonalEmail(email)) {
      personalEmail = personalEmail ?? email;
    } else {
      workEmail = workEmail ?? email;
    }
  }

  const phones = extractContactOutPhones(
    (contactInfo.phones as unknown[]) ?? [],
  );
  const personalPhone =
    phones.find((p) => p.kind === "mobile")?.number ?? phones[0]?.number ?? null;

  if (!workEmail && !personalEmail && !personalPhone && phones.length === 0) {
    return null;
  }

  return {
    name,
    title,
    linkedinUrl,
    workEmail,
    personalEmail,
    phone: personalPhone ?? phones[0]?.number ?? null,
    personalPhone,
    phones,
  };
}

/** Domain search — used when Apollo HR title search returns no contacts. */
export async function searchContactOutByDomain(
  apiKey: string,
  domain: string,
  limit = 3,
): Promise<ContactOutDomainPerson[]> {
  const resp = await fetch(CONTACTOUT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      token: apiKey,
    },
    body: JSON.stringify({
      page: 1,
      page_size: Math.max(limit * 3, 10),
      domain: [domain.replace(/^https?:\/\//, "").replace(/^www\./, "")],
      data_types: ["personal_email", "work_email", "phone"],
      reveal_info: true,
      current_company_only: true,
    }),
  });

  if (!resp.ok) return [];
  const data = (await resp.json()) as Record<string, unknown>;
  if (isContactOutSampleResponse(data)) return [];

  const profiles = (data.profiles ?? {}) as Record<string, Record<string, unknown>>;
  const parsed: ContactOutDomainPerson[] = [];

  for (const [linkedinUrl, profile] of Object.entries(profiles)) {
    const person = parseProfile(linkedinUrl, profile);
    if (person) parsed.push(person);
  }

  return parsed
    .sort((a, b) => titleRank(a.title) - titleRank(b.title))
    .slice(0, limit);
}
