import {
  extractContactOutPhones,
  mergeSourcedPhones,
  type SourcedPhone,
} from "@/lib/contact-phones";
import {
  pickPersonalEmailFromList,
  pickWorkEmail,
} from "@/lib/contact-enrichment-limits";
import {
  contactTitlePriority,
  emailMatchesCompanyDomain,
  isExcludedContactTitle,
} from "@/lib/contact-title-priority";
import { isPersonalEmail } from "@/lib/phone-utils";
import { isContactOutSampleResponse } from "@/lib/contactout-samples";
import {
  assertPaidEgressAllowed,
  recordProviderUsageEvent,
  type PaidEgressContext,
} from "@/lib/paid-egress";

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

function profileSortKey(
  person: ContactOutDomainPerson,
  domain: string,
): [number, number, number] {
  const title = contactTitlePriority(person.title);
  const domainEmail =
    emailMatchesCompanyDomain(person.workEmail, domain) ||
    emailMatchesCompanyDomain(person.personalEmail, domain)
      ? 0
      : 1;
  const hasChannel =
    person.workEmail || person.personalEmail || person.phone ? 0 : 1;
  return [title, domainEmail, hasChannel];
}

function hasCredibleCompanyAffiliation(
  person: ContactOutDomainPerson,
  domain: string | null,
): boolean {
  if (!domain) {
    return contactTitlePriority(person.title) <= 30;
  }
  if (
    emailMatchesCompanyDomain(person.workEmail, domain) ||
    emailMatchesCompanyDomain(person.personalEmail, domain)
  ) {
    return true;
  }
  if (
    person.workEmail &&
    !emailMatchesCompanyDomain(person.workEmail, domain) &&
    contactTitlePriority(person.title) > 22
  ) {
    return false;
  }
  return contactTitlePriority(person.title) <= 30;
}

async function searchContactOutPeople(
  apiKey: string,
  body: Record<string, unknown>,
  domainForSort: string | null,
  limit: number,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<ContactOutDomainPerson[]> {
  await assertPaidEgressAllowed("contactout", "people/search", context, {
    companyId,
    estimatedCost: Math.max(limit, 1),
    metadata: { body: { ...body, page_size: limit } },
  });
  const resp = await fetch(CONTACTOUT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      token: apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) return [];
  const data = (await resp.json()) as Record<string, unknown>;
  if (isContactOutSampleResponse(data)) return [];

  const profiles = (data.profiles ?? {}) as Record<string, Record<string, unknown>>;
  const parsed: ContactOutDomainPerson[] = [];

  for (const [linkedinUrl, profile] of Object.entries(profiles)) {
    const person = parseProfile(linkedinUrl, profile);
    if (person && hasCredibleCompanyAffiliation(person, domainForSort)) {
      parsed.push(person);
    }
  }

  const sortDomain = domainForSort ?? "";
  const results = parsed
    .sort((a, b) => {
      const ka = profileSortKey(a, sortDomain);
      const kb = profileSortKey(b, sortDomain);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    })
    .slice(0, limit);
  // Cost = profiles actually revealed; an empty search must not eat budget.
  await recordProviderUsageEvent("contactout", "people/search", context ?? "automated_scrape", {
    companyId,
    recordsReturned: results.length,
    estimatedCost: results.length,
    metadata: { body: { ...body, page_size: limit } },
  });
  return results;
}

/** Domain search — used when Apollo HR title search returns no contacts. */
export async function searchContactOutByDomain(
  apiKey: string,
  domain: string,
  limit = 3,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<ContactOutDomainPerson[]> {
  const normalized = domain.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return searchContactOutPeople(
    apiKey,
    {
      page: 1,
      page_size: limit,
      domain: [normalized],
      data_types: ["personal_email", "work_email", "phone"],
      reveal_info: true,
      current_company_only: true,
    },
    normalized,
    limit,
    context,
    companyId,
  );
}

/** Company-name search when domain is missing or guessed. */
export async function searchContactOutByCompanyName(
  apiKey: string,
  companyName: string,
  limit = 3,
  domainForSort: string | null = null,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<ContactOutDomainPerson[]> {
  return searchContactOutPeople(
    apiKey,
    {
      page: 1,
      page_size: limit,
      company: [companyName.trim()],
      data_types: ["personal_email", "work_email", "phone"],
      reveal_info: true,
      current_company_only: true,
    },
    domainForSort,
    limit,
    context,
    companyId,
  );
}

function parseProfile(
  linkedinUrl: string,
  profile: Record<string, unknown>,
): ContactOutDomainPerson | null {
  const name = String(profile.full_name ?? "").trim();
  const title = String(profile.title ?? profile.headline ?? "").trim();
  if (!name || isExcludedContactTitle(title)) return null;

  const contactInfo = (profile.contact_info ?? {}) as Record<string, unknown>;
  const workEmails = (contactInfo.work_emails as string[] | undefined) ?? [];
  const personalEmails =
    (contactInfo.personal_emails as string[] | undefined) ?? [];
  const rawEmails = (contactInfo.emails as string[] | undefined) ?? [];

  let workEmail = pickWorkEmail(workEmails);
  let personalEmail = pickPersonalEmailFromList(personalEmails);
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
    phones: mergeSourcedPhones(phones),
  };
}
