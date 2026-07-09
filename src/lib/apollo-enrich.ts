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
import { isPersonalEmail, parsePhoneValue } from "@/lib/phone-utils";

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
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!base?.startsWith("https://")) return null;
  return `${base.replace(/\/$/, "")}/api/apollo/webhook`;
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

function extractPhone(person: Record<string, unknown>): string | null {
  const phones = (person.phone_numbers as Array<Record<string, string>>) ?? [];
  for (const entry of phones) {
    const typeCd = (entry.type_cd || entry.type || "").toLowerCase();
    if (typeCd === "mobile" || typeCd === "other" || typeCd === "cell") {
      return (
        entry.sanitized_number ||
        entry.raw_number ||
        entry.number ||
        null
      );
    }
  }
  return null;
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
}): Promise<EnrichedContact[]> {
  const {
    apiKey,
    domain,
    jobLocations,
    contactsPerCompany = CONTACTS_PER_COMPANY,
    existingApolloIds = new Set(),
    contactOutApiKey,
  } = options;

  const useContactOut = Boolean(contactOutApiKey);
  const apolloPhone = ENRICH_PHONE && !useContactOut;

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

    const workEmail = String(enriched.email);
    const linkedinUrl = enriched.linkedin_url
      ? String(enriched.linkedin_url)
      : person.linkedin_url
        ? String(person.linkedin_url)
        : null;

    let personalEmail: string | null = null;
    let personalPhone: string | null = null;
    let email = workEmail;
    let phone = extractPhone(enriched);
    let sourceProvider = "apollo";

    if (useContactOut && linkedinUrl && contactOutApiKey) {
      const co = await enrichFromContactOut(linkedinUrl, contactOutApiKey);
      if (co) {
        if (co.personalEmail) {
          personalEmail = co.personalEmail;
          email = co.personalEmail;
        }
        if (co.personalPhone) {
          personalPhone = co.personalPhone;
          phone = co.personalPhone;
        }
        if (co.personalEmail || co.personalPhone) {
          sourceProvider = "apollo+contactout";
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (email && isPersonalEmail(email)) {
      personalEmail = email;
    }

    results.push({
      name,
      title: String(enriched.title ?? person.title ?? ""),
      email,
      workEmail: personalEmail && workEmail !== personalEmail ? workEmail : null,
      personalEmail,
      phone: parsePhoneValue(phone),
      personalPhone: parsePhoneValue(personalPhone),
      companyPhone: null,
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
