import { eq } from "drizzle-orm";
import {
  CONTACTS_PER_COMPANY,
  ENRICH_PHONE,
  TARGET_SENIORITIES,
  TARGET_TITLES,
} from "@/lib/enrichment-config";
import {
  apolloLocationQueries,
  collectJobLocations,
  formatPersonLocation,
  personMatchesLocation,
} from "@/lib/location-match";
import { enrichFromContactOut, dedupeCompanyPhones } from "@/lib/contactout-enrich";
import { isContactOutCreditsAvailable, markContactOutCreditsExhausted } from "@/lib/contactout-credits";
import {
  extractApolloPhones,
  mergeSourcedPhones,
  pickPrimaryFromPhones,
  contactPhonesForDisplay,
  syncContactPhoneFields,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { isPersonalEmail } from "@/lib/phone-utils";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export type EnrichedContact = {
  name: string;
  title: string;
  email: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  phone: string | null;
  personalPhone: string | null;
  companyPhone: string | null;
  phones: SourcedPhone[];
  linkedinUrl: string | null;
  apolloId: string;
  sourceProvider: string;
  locationMatched: boolean;
  contactLocation: string | null;
  jobLocation: string | null;
};

const TITLE_RANK: Array<[string, number]> = [
  ["chief executive", 0],
  ["ceo", 0],
  ["president", 1],
  ["founder", 2],
  ["co-founder", 2],
  ["chief people", 7],
  ["chro", 7],
  ["vp people", 8],
  ["vp human", 8],
  ["vp hr", 8],
  ["head of hr", 9],
  ["hr director", 11],
];

const SENIORITY_RANK: Record<string, number> = {
  c_suite: 0,
  owner: 1,
  founder: 1,
  vp: 2,
  head: 3,
  director: 4,
  manager: 5,
};

function apolloHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key": apiKey,
  };
}

function webhookUrl(): string | null {
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.CRM_API_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  ];
  for (const raw of candidates) {
    const base = raw?.trim().replace(/\/$/, "");
    if (base?.startsWith("https://")) {
      return `${base}/api/apollo/webhook`;
    }
  }
  return null;
}

export function apolloWebhookConfigured(): boolean {
  return webhookUrl() !== null;
}

function executiveRank(person: Record<string, unknown>): [number, number, string] {
  const title = String(person.title ?? "").toLowerCase();
  let titleRank = 50;
  for (const [keyword, rank] of TITLE_RANK) {
    if (title.includes(keyword)) {
      titleRank = Math.min(titleRank, rank);
      break;
    }
  }
  const seniority = String(person.seniority ?? "").toLowerCase();
  return [titleRank, SENIORITY_RANK[seniority] ?? 20, title];
}

function personSortKey(
  person: Record<string, unknown>,
  jobLocations: ReturnType<typeof collectJobLocations>,
): [number, number, number, string] {
  const locationRank = personMatchesLocation(person, jobLocations) ? 0 : 1;
  const [t, s, title] = executiveRank(person);
  return [locationRank, t, s, title];
}

async function searchPeople(
  apiKey: string,
  domain: string,
  perPage: number,
  personLocations?: string[],
): Promise<Record<string, unknown>[]> {
  const payload: Record<string, unknown> = {
    q_organization_domains_list: [domain],
    person_titles: TARGET_TITLES,
    include_similar_titles: true,
    person_seniorities: TARGET_SENIORITIES,
    page: 1,
    per_page: perPage,
  };
  if (personLocations?.length) payload.person_locations = personLocations;

  const resp = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: "POST",
    headers: apolloHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Apollo search failed: ${await resp.text()}`);
  const data = (await resp.json()) as { people?: Record<string, unknown>[] };
  return data.people ?? [];
}

async function matchPerson(
  apiKey: string,
  personId: string,
  enrichPhone: boolean,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ id: personId });
  const hook = webhookUrl();
  if (enrichPhone && hook) {
    params.set("reveal_phone_number", "true");
    params.set("webhook_url", hook);
  }

  const resp = await fetch(`${APOLLO_BASE}/people/match?${params}`, {
    method: "POST",
    headers: apolloHeaders(apiKey),
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    if (detail.toLowerCase().includes("insufficient credits")) {
      throw new Error("Apollo out of credits — add credits or upgrade your plan");
    }
    return null;
  }
  const data = (await resp.json()) as { person?: Record<string, unknown> };
  return data.person ?? null;
}

function mergePeople(
  local: Record<string, unknown>[],
  broad: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (const person of [...local, ...broad]) {
    const id = String(person.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(person);
  }
  return merged;
}

export async function enrichCompanyContacts(options: {
  apiKey: string;
  domain: string;
  jobLocations: string[];
  contactsPerCompany?: number;
  existingApolloIds?: Set<string>;
  contactOutApiKey?: string;
  contactOutAvailable?: boolean;
}): Promise<EnrichedContact[]> {
  const {
    apiKey,
    domain,
    jobLocations,
    contactsPerCompany = CONTACTS_PER_COMPANY,
    existingApolloIds = new Set(),
    contactOutApiKey,
    contactOutAvailable = true,
  } = options;

  const useContactOut = Boolean(contactOutApiKey) && contactOutAvailable;
  const apolloPhone = ENRICH_PHONE;

  const parsedLocations = collectJobLocations(jobLocations);
  const jobLocationLabel = parsedLocations[0]?.label ?? null;
  const apolloLocations = [
    ...new Set(parsedLocations.flatMap(apolloLocationQueries)),
  ];

  const perPage = Math.max(contactsPerCompany * 5, 10);
  const localPeople = apolloLocations.length
    ? await searchPeople(apiKey, domain, perPage, apolloLocations)
    : [];
  const broadPeople = await searchPeople(apiKey, domain, perPage);
  const people = mergePeople(localPeople, broadPeople).sort((a, b) => {
    const ka = personSortKey(a, parsedLocations);
    const kb = personSortKey(b, parsedLocations);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });

  const results: EnrichedContact[] = [];

  for (const person of people) {
    if (results.length >= contactsPerCompany) break;
    if (!person.has_email) continue;

    const personId = String(person.id ?? "");
    if (!personId || existingApolloIds.has(personId)) continue;

    const enriched = await matchPerson(apiKey, personId, apolloPhone);
    if (!enriched?.email) continue;

    const first = String(enriched.first_name ?? person.first_name ?? "");
    const last =
      String(enriched.last_name ?? person.last_name ?? person.last_name_obfuscated ?? "");
    const name = String(enriched.name ?? `${first} ${last}`.trim());
    const locationMatched =
      personMatchesLocation(enriched, parsedLocations) ||
      personMatchesLocation(person, parsedLocations);

    const workEmailRaw = String(enriched.email);
    const apolloWorkEmail = isPersonalEmail(workEmailRaw) ? null : workEmailRaw;
    const linkedinUrl = enriched.linkedin_url
      ? String(enriched.linkedin_url)
      : person.linkedin_url
        ? String(person.linkedin_url)
        : null;

    let personalEmail: string | null = isPersonalEmail(workEmailRaw)
      ? workEmailRaw
      : null;
    let email = personalEmail ?? apolloWorkEmail;
    let sourceProvider = "apollo";

    let phones = extractApolloPhones(enriched);

    if (useContactOut && linkedinUrl && contactOutApiKey) {
      const co = await enrichFromContactOut(linkedinUrl, contactOutApiKey);
      if (co?.phoneApiLocked) {
        markContactOutCreditsExhausted();
      } else if (co && !co.phoneApiLocked) {
        phones = mergeSourcedPhones(phones, co.phones);
        if (co.personalEmail) {
          personalEmail = co.personalEmail;
          email = co.personalEmail;
        }
        if (co.personalEmail || co.phones.length) {
          sourceProvider = "apollo+contactout";
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const primary = pickPrimaryFromPhones(phones);

    results.push({
      name,
      title: String(enriched.title ?? person.title ?? ""),
      email,
      workEmail: apolloWorkEmail,
      personalEmail,
      phone: primary.phone,
      personalPhone: primary.personalPhone,
      companyPhone: primary.companyPhone,
      phones,
      linkedinUrl,
      apolloId: personId,
      sourceProvider,
      locationMatched,
      contactLocation:
        formatPersonLocation(enriched) ?? formatPersonLocation(person),
      jobLocation: jobLocationLabel,
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  return dedupeCompanyPhones(results);
}

function contactNeedsApolloRefresh(
  contact: {
    phone: string | null;
    personalPhone: string | null;
    phones: SourcedPhone[] | null;
    personalEmail: string | null;
    workEmail: string | null;
    email: string | null;
    linkedinUrl: string | null;
  },
  contactOutAvailable: boolean,
): boolean {
  const hasPhone =
    Boolean(contact.personalPhone || contact.phone) ||
    (contact.phones?.length ?? 0) > 0;
  const needsLinkedIn = !contact.linkedinUrl;
  const needsWorkEmail = !contact.workEmail && !contact.email;

  if (!contactOutAvailable) {
    return !hasPhone || needsLinkedIn || needsWorkEmail;
  }

  const needsPersonal = !contact.personalEmail;
  return !hasPhone || needsPersonal || needsLinkedIn || needsWorkEmail;
}

/** Re-run Apollo match on saved contacts (phones arrive async via webhook too). */
export async function refreshCompanyContactsFromApollo(
  companyId: string,
  apiKey: string,
  contactOutAvailable = true,
): Promise<{
  updated: number;
  phonesRequested: number;
  phonesAdded: number;
  checked: number;
}> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId));

  const withApollo = rows.filter((c) => c.apolloId);
  let updated = 0;
  let phonesRequested = 0;
  let phonesAdded = 0;

  for (const contact of withApollo) {
    if (!contact.apolloId || !contactNeedsApolloRefresh(contact, contactOutAvailable)) {
      continue;
    }

    const beforePhones = contactPhonesForDisplay(contact).length;
    phonesRequested += 1;
    const enriched = await matchPerson(apiKey, contact.apolloId, ENRICH_PHONE);
    if (!enriched) continue;

    const apolloPhones = extractApolloPhones(enriched);
    const phones = mergeSourcedPhones(contactPhonesForDisplay(contact), apolloPhones);
    const synced = syncContactPhoneFields({ ...contact, phones });
    const primary = pickPrimaryFromPhones(synced.phones);
    const afterPhones = synced.phones.length;

    const workEmail =
      contact.workEmail ??
      (contact.email && !isPersonalEmail(contact.email) ? contact.email : null);
    const enrichedWork = enriched.email ? String(enriched.email) : null;
    const nextWorkEmail =
      workEmail ?? (enrichedWork && !isPersonalEmail(enrichedWork) ? enrichedWork : null);

    let personalEmail = contact.personalEmail;
    let email = contact.email;
    if (enrichedWork && isPersonalEmail(enrichedWork)) {
      personalEmail = enrichedWork;
      email = enrichedWork;
    }

    const linkedinUrl =
      contact.linkedinUrl ??
      (enriched.linkedin_url ? String(enriched.linkedin_url) : null);

    const gainedPhone = afterPhones > beforePhones;
    const gainedEmail =
      Boolean(nextWorkEmail && !contact.workEmail && !contact.email) ||
      Boolean(personalEmail && !contact.personalEmail);

    const changed =
      linkedinUrl !== contact.linkedinUrl ||
      personalEmail !== contact.personalEmail ||
      email !== contact.email ||
      nextWorkEmail !== contact.workEmail ||
      JSON.stringify(synced.phones) !== JSON.stringify(contact.phones ?? []) ||
      primary.phone !== contact.phone ||
      primary.personalPhone !== contact.personalPhone;

    if (!changed) continue;

    await db
      .update(contacts)
      .set({
        linkedinUrl,
        email,
        workEmail: nextWorkEmail ?? contact.workEmail,
        personalEmail,
        phones: synced.phones,
        phone: primary.phone,
        personalPhone: primary.personalPhone,
        companyPhone: primary.companyPhone,
        title: contact.title || String(enriched.title ?? ""),
      })
      .where(eq(contacts.id, contact.id));

    updated += 1;
    if (gainedPhone) phonesAdded += 1;
    if (gainedEmail && !gainedPhone) {
      // still counts as meaningful contact enrichment
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return { updated, phonesRequested, phonesAdded, checked: withApollo.length };
}
