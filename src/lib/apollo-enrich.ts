import { eq } from "drizzle-orm";
import {
  CONTACTS_PER_COMPANY,
  ENRICH_PHONE,
  FALLBACK_TITLES,
  FALLBACK_SENIORITIES,
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
import { markContactOutCreditsExhausted } from "@/lib/contactout-credits";
import {
  extractApolloPhones,
  mergeSourcedPhones,
  contactPhonesForDisplay,
  type SourcedPhone,
} from "@/lib/contact-phones";
import {
  contactNeedsContactOutEnrichment,
  directPhoneCount,
  normalizeContactChannels,
} from "@/lib/contact-enrichment-limits";
import { isPersonalEmail } from "@/lib/phone-utils";
import { db } from "@/lib/db";
import { contacts } from "@/lib/db/schema";
import {
  assertPaidEgressAllowed,
  recordProviderUsageEvent,
  type PaidEgressContext,
} from "@/lib/paid-egress";
import {
  getOrCreateSettings,
  normalizeContactTitles,
} from "@/lib/pipeline-config";

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

export async function searchPeopleByCompanyName(
  apiKey: string,
  companyName: string,
  perPage: number,
  personLocations?: string[],
  personTitles: string[] = TARGET_TITLES,
  personSeniorities: string[] = TARGET_SENIORITIES,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<Record<string, unknown>[]> {
  const payload: Record<string, unknown> = {
    q_organization_name: companyName,
    person_titles: personTitles,
    include_similar_titles: true,
    page: 1,
    per_page: perPage,
  };
  if (personSeniorities.length) {
    payload.person_seniorities = personSeniorities;
  }
  if (personLocations?.length) payload.person_locations = personLocations;

  await assertPaidEgressAllowed("apollo", "mixed_people/api_search", context, {
    companyId,
    estimatedCost: 1,
    metadata: { companyName, personLocations },
  });
  const resp = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: "POST",
    headers: apolloHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { people?: Record<string, unknown>[] };
  await recordProviderUsageEvent("apollo", "mixed_people/api_search", context ?? "automated_scrape", {
    companyId,
    recordsReturned: data.people?.length ?? 0,
    estimatedCost: 1,
    metadata: { companyName, personLocations },
  });
  return data.people ?? [];
}

export async function searchPeople(
  apiKey: string,
  domain: string,
  perPage: number,
  personLocations?: string[],
  personTitles: string[] = TARGET_TITLES,
  personSeniorities: string[] = TARGET_SENIORITIES,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<Record<string, unknown>[]> {
  const payload: Record<string, unknown> = {
    q_organization_domains_list: [domain],
    person_titles: personTitles,
    include_similar_titles: true,
    page: 1,
    per_page: perPage,
  };
  if (personSeniorities.length) {
    payload.person_seniorities = personSeniorities;
  }
  if (personLocations?.length) payload.person_locations = personLocations;

  await assertPaidEgressAllowed("apollo", "mixed_people/api_search", context, {
    companyId,
    estimatedCost: 1,
    metadata: { domain, personLocations },
  });
  const resp = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: "POST",
    headers: apolloHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Apollo search failed: ${await resp.text()}`);
  const data = (await resp.json()) as { people?: Record<string, unknown>[] };
  await recordProviderUsageEvent("apollo", "mixed_people/api_search", context ?? "automated_scrape", {
    companyId,
    recordsReturned: data.people?.length ?? 0,
    estimatedCost: 1,
    metadata: { domain, personLocations },
  });
  return data.people ?? [];
}

export async function matchPerson(
  apiKey: string,
  personId: string,
  enrichPhone: boolean,
  context?: PaidEgressContext,
  companyId?: string,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ id: personId });
  const hook = webhookUrl();
  if (enrichPhone && hook) {
    params.set("reveal_phone_number", "true");
    params.set("webhook_url", hook);
  }

  const estimatedCost = enrichPhone ? 8 : 1;
  await assertPaidEgressAllowed("apollo", "people/match", context, {
    companyId,
    estimatedCost,
    metadata: { personId, enrichPhone },
  });
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
  await recordProviderUsageEvent("apollo", "people/match", context ?? "automated_scrape", {
    companyId,
    contactId: undefined,
    recordsReturned: data.person ? 1 : 0,
    estimatedCost,
    metadata: { personId, enrichPhone },
  });
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
  companyName?: string;
  jobLocations: string[];
  contactsPerCompany?: number;
  existingApolloIds?: Set<string>;
  contactOutApiKey?: string;
  contactOutAvailable?: boolean;
  context?: PaidEgressContext;
  companyId?: string;
}): Promise<EnrichedContact[]> {
  const {
    apiKey,
    domain,
    companyName,
    jobLocations,
    contactsPerCompany = CONTACTS_PER_COMPANY,
    existingApolloIds = new Set(),
    contactOutApiKey,
    contactOutAvailable = true,
    context,
    companyId,
  } = options;

  const useContactOut = Boolean(contactOutApiKey) && contactOutAvailable;
  const apolloPhone = ENRICH_PHONE;

  const settings = await getOrCreateSettings();
  const personTitles = normalizeContactTitles(settings.contactTitles);

  const parsedLocations = collectJobLocations(jobLocations);
  const jobLocationLabel = parsedLocations[0]?.label ?? null;
  const apolloLocations = [
    ...new Set(parsedLocations.flatMap(apolloLocationQueries)),
  ];

  const perPage = Math.max(contactsPerCompany * 5, 10);
  const localPeople = apolloLocations.length
    ? await searchPeople(apiKey, domain, perPage, apolloLocations, personTitles, TARGET_SENIORITIES, context, companyId)
    : [];
  const broadPeople = await searchPeople(
    apiKey,
    domain,
    perPage,
    undefined,
    personTitles,
    TARGET_SENIORITIES,
    context,
    companyId,
  );
  let people = mergePeople(localPeople, broadPeople);

  if (people.length === 0) {
    const fallbackLocal = apolloLocations.length
      ? await searchPeople(
          apiKey,
          domain,
          perPage,
          apolloLocations,
          FALLBACK_TITLES,
          FALLBACK_SENIORITIES,
          context,
          companyId,
        )
      : [];
    const fallbackBroad = await searchPeople(
      apiKey,
      domain,
      perPage,
      undefined,
      FALLBACK_TITLES,
      FALLBACK_SENIORITIES,
      context,
      companyId,
    );
    people = mergePeople(fallbackLocal, fallbackBroad);
  }

  if (people.length === 0 && companyName?.trim()) {
    const nameLocal = apolloLocations.length
      ? await searchPeopleByCompanyName(
          apiKey,
          companyName,
          perPage,
          apolloLocations,
          personTitles,
          TARGET_SENIORITIES,
          context,
          companyId,
        )
      : [];
    const nameBroad = await searchPeopleByCompanyName(
      apiKey,
      companyName,
      perPage,
      undefined,
      personTitles,
      TARGET_SENIORITIES,
      context,
      companyId,
    );
    let namePeople = mergePeople(nameLocal, nameBroad);
    if (namePeople.length === 0) {
      const nameFallbackLocal = apolloLocations.length
        ? await searchPeopleByCompanyName(
            apiKey,
            companyName,
            perPage,
            apolloLocations,
            FALLBACK_TITLES,
            FALLBACK_SENIORITIES,
            context,
            companyId,
          )
        : [];
      const nameFallbackBroad = await searchPeopleByCompanyName(
        apiKey,
        companyName,
        perPage,
        undefined,
        FALLBACK_TITLES,
        FALLBACK_SENIORITIES,
        context,
        companyId,
      );
      namePeople = mergePeople(nameFallbackLocal, nameFallbackBroad);
    }
    people = namePeople;
  }

  people.sort((a, b) => {
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

    const enriched = await matchPerson(
      apiKey,
      personId,
      apolloPhone && !useContactOut,
      context,
      companyId,
    );
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

    let workEmail = apolloWorkEmail;
    let personalEmail: string | null = isPersonalEmail(workEmailRaw)
      ? workEmailRaw
      : null;
    let email = personalEmail ?? workEmail;
    let sourceProvider = "apollo";

    let phones = extractApolloPhones(enriched);

    if (useContactOut && linkedinUrl && contactOutApiKey) {
      const co = await enrichFromContactOut(linkedinUrl, contactOutApiKey, {}, context, companyId);
      if (co?.phoneApiLocked) {
        await markContactOutCreditsExhausted();
      } else if (co && !co.phoneApiLocked) {
        phones = mergeSourcedPhones(phones, co.phones);
        if (co.personalEmail) {
          personalEmail = co.personalEmail;
        }
        if (co.workEmail && !workEmail) {
          workEmail = co.workEmail;
        }
        email = personalEmail ?? workEmail;
        if (co.personalEmail || co.workEmail || co.phones.length) {
          sourceProvider = "apollo+contactout";
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const normalized = normalizeContactChannels({
      workEmail,
      personalEmail,
      email,
      phones,
    });

    results.push({
      name,
      title: String(enriched.title ?? person.title ?? ""),
      email: normalized.email,
      workEmail: normalized.workEmail,
      personalEmail: normalized.personalEmail,
      phone: normalized.phone,
      personalPhone: normalized.personalPhone,
      companyPhone: normalized.companyPhone,
      phones: normalized.phones,
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
    sourceProvider?: string | null;
  },
  contactOutAvailable: boolean,
): boolean {
  if (contactOutAvailable && !contactNeedsContactOutEnrichment(contact)) {
    return !contact.linkedinUrl;
  }

  const hasPhone = directPhoneCount(contact) > 0;
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
  context?: PaidEgressContext,
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
    const requestApolloPhone =
      ENRICH_PHONE && !(contactOutAvailable && directPhoneCount(contact) > 0);
    if (requestApolloPhone) phonesRequested += 1;
    const enriched = await matchPerson(
      apiKey,
      contact.apolloId,
      requestApolloPhone,
      context,
      companyId,
    );
    if (!enriched) continue;

    const apolloPhones = requestApolloPhone ? extractApolloPhones(enriched) : [];
    const normalized = normalizeContactChannels({
      ...contact,
      phones: mergeSourcedPhones(contactPhonesForDisplay(contact), apolloPhones),
      workEmail:
        contact.workEmail ??
        (contact.email && !isPersonalEmail(contact.email) ? contact.email : null) ??
        (enriched.email && !isPersonalEmail(String(enriched.email))
          ? String(enriched.email)
          : null),
      personalEmail:
        contact.personalEmail ??
        (enriched.email && isPersonalEmail(String(enriched.email))
          ? String(enriched.email)
          : null),
    });
    const afterPhones = normalized.phones.length;
    const linkedinUrl =
      contact.linkedinUrl ??
      (enriched.linkedin_url ? String(enriched.linkedin_url) : null);

    const gainedPhone = afterPhones > beforePhones;
    const gainedEmail =
      Boolean(normalized.workEmail && !contact.workEmail) ||
      Boolean(normalized.personalEmail && !contact.personalEmail);

    const changed =
      linkedinUrl !== contact.linkedinUrl ||
      normalized.personalEmail !== contact.personalEmail ||
      normalized.email !== contact.email ||
      normalized.workEmail !== contact.workEmail ||
      JSON.stringify(normalized.phones) !== JSON.stringify(contact.phones ?? []) ||
      normalized.phone !== contact.phone ||
      normalized.personalPhone !== contact.personalPhone;

    if (!changed) continue;

    await db
      .update(contacts)
      .set({
        linkedinUrl,
        email: normalized.email,
        workEmail: normalized.workEmail,
        personalEmail: normalized.personalEmail,
        phones: normalized.phones,
        phone: normalized.phone,
        personalPhone: normalized.personalPhone,
        companyPhone: normalized.companyPhone,
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
