/**
 * Feature 1 — selective contact enrichment: discovery → reveal-on-selection.
 *
 * Discovery runs the Apollo people-search with REVEAL OFF: candidates come
 * back with name · title · seniority · LinkedIn · location and ZERO reveal
 * credits spent. (The search itself costs a search credit — stated honestly
 * in the cost preview — and is CACHED per company so it's paid once, ever.)
 *
 * Reveal spends credits only on the contacts the user selected, on the
 * channels they chose (email vs email+phone). Already-revealed contacts are
 * never re-charged.
 *
 * Every provider call goes through the existing manual_enrich egress gate,
 * per-endpoint usage logging, and daily credit caps — unchanged.
 */

import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, companyIcp, contacts, jobListings } from "@/lib/db/schema";
import {
  matchPerson,
  searchPeople,
  searchPeopleByCompanyName,
} from "@/lib/apollo-enrich";
import { enrichFromContactOut } from "@/lib/contactout-enrich";
import { markContactOutCreditsExhausted } from "@/lib/contactout-credits";
import { normalizeContactChannels } from "@/lib/contact-enrichment-limits";
import {
  extractApolloPhones,
  mergeSourcedPhones,
} from "@/lib/contact-phones";
import {
  collectJobLocations,
  apolloLocationQueries,
  formatPersonLocation,
  personMatchesLocation,
} from "@/lib/location-match";
import { isPersonalEmail } from "@/lib/phone-utils";
import type { PaidEgressContext } from "@/lib/paid-egress";
import {
  detectSector,
  fallbackTitles,
  getContactTargetsConfig,
  resolveSizeBand,
  titlePriorityRank,
  titlesForDiscovery,
  type SizeBand,
} from "./contact-targets";

export type DiscoveryCandidate = {
  contactId: string;
  name: string;
  title: string | null;
  linkedinUrl: string | null;
  contactLocation: string | null;
  locationMatched: boolean;
  revealStatus: "discovered" | "revealed" | "legacy";
  isPrimary: boolean;
  priorityRank: number;
  /** Already has email/phone on file — viewing is free, never re-charged. */
  alreadyCallable: boolean;
};

export type DiscoveryResult = {
  candidates: DiscoveryCandidate[];
  cached: boolean;
  sector: string;
  sizeBand: SizeBand;
  usedUnion: boolean;
  usedFallback: boolean;
  searchesSpent: number;
};

function candidateFromContact(
  contact: typeof contacts.$inferSelect,
  sector: string,
  sizeBand: SizeBand,
): DiscoveryCandidate {
  const callable = Boolean(
    contact.email ||
      contact.workEmail ||
      contact.personalEmail ||
      contact.phone ||
      contact.personalPhone,
  );
  return {
    contactId: contact.id,
    name: contact.name,
    title: contact.title,
    linkedinUrl: contact.linkedinUrl,
    contactLocation: contact.contactLocation,
    locationMatched: contact.locationMatched,
    revealStatus:
      contact.revealStatus === "discovered"
        ? "discovered"
        : contact.revealStatus === "revealed"
          ? "revealed"
          : "legacy",
    isPrimary: contact.isPrimary ?? false,
    priorityRank: titlePriorityRank(contact.title, sector, sizeBand),
    alreadyCallable: callable,
  };
}

function sortCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  // In-market first (never pay to reveal the wrong-office person), then by
  // the sector priority order, then already-revealed contacts up front.
  return [...candidates].sort((a, b) => {
    if (a.locationMatched !== b.locationMatched) return a.locationMatched ? -1 : 1;
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    if (a.alreadyCallable !== b.alreadyCallable) return a.alreadyCallable ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function loadSectorAndSize(companyId: string): Promise<{
  company: typeof companies.$inferSelect;
  sector: string;
  sizeBand: SizeBand;
}> {
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) throw new Error("Company not found");

  const [icp] = await db
    .select({ sizeBand: companyIcp.companySizeBand })
    .from(companyIcp)
    .where(eq(companyIcp.companyId, companyId))
    .limit(1);

  const config = getContactTargetsConfig();
  const sector = detectSector(company.name, company.industry, config);
  const target =
    config.contact_targets[sector] ?? config.contact_targets.default;
  const sizeBand = resolveSizeBand(
    company.estimatedEmployees,
    icp?.sizeBand ?? null,
    target,
  );
  return { company, sector, sizeBand };
}

/** Cached candidate list — never re-searches once discovery has completed. */
export async function getCachedCandidates(
  companyId: string,
): Promise<DiscoveryResult | null> {
  const { company, sector, sizeBand } = await loadSectorAndSize(companyId);
  if (!company.discoveryCompletedAt) return null;

  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId));

  return {
    candidates: sortCandidates(
      rows.map((c) => candidateFromContact(c, sector, sizeBand)),
    ),
    cached: true,
    sector,
    sizeBand,
    usedUnion: sizeBand === "unknown",
    usedFallback: false,
    searchesSpent: 0,
  };
}

/**
 * Discovery: ONE reveal-off people-search per company (a single fallback
 * generic search only when the allowlist finds nobody). Candidates are
 * persisted as reveal_status='discovered' rows with no email/phone.
 */
export async function discoverCompanyContacts(options: {
  companyId: string;
  apiKey: string;
  context: PaidEgressContext;
  force?: boolean;
}): Promise<DiscoveryResult> {
  const { companyId, apiKey, context, force = false } = options;

  if (!force) {
    const cached = await getCachedCandidates(companyId);
    if (cached) return cached;
  }

  const { company, sector, sizeBand } = await loadSectorAndSize(companyId);
  const config = getContactTargetsConfig();
  const { titles, usedUnion } = titlesForDiscovery(sector, sizeBand, config);
  const perPage = config.discovery.search_per_page;

  const listings = await db
    .select({ location: jobListings.location })
    .from(jobListings)
    .where(eq(jobListings.companyId, companyId));
  const jobLocations = listings
    .map((l) => l.location)
    .filter((l): l is string => Boolean(l));
  const parsedLocations = collectJobLocations(jobLocations);
  const jobLocationLabel = parsedLocations[0]?.label ?? null;
  const apolloLocations = [
    ...new Set(parsedLocations.flatMap(apolloLocationQueries)),
  ];

  // ONE search per company: broad within the firm (allowlist titles only,
  // no seniority narrowing — the allowlist IS the filter, per the spec).
  let searchesSpent = 0;
  let usedFallback = false;

  async function runSearch(searchTitles: string[]) {
    searchesSpent += 1;
    if (company.domain) {
      return searchPeople(
        apiKey,
        company.domain,
        perPage,
        apolloLocations.length ? apolloLocations : undefined,
        searchTitles,
        [],
        context,
        companyId,
      );
    }
    return searchPeopleByCompanyName(
      apiKey,
      company.name,
      perPage,
      apolloLocations.length ? apolloLocations : undefined,
      searchTitles,
      [],
      context,
      companyId,
    );
  }

  let people = await runSearch(titles);

  // Location-scoped search can be empty for multi-office firms — one broad
  // retry without the location narrowing, same allowlist, before fallback.
  if (people.length === 0 && apolloLocations.length && company.domain) {
    searchesSpent += 1;
    people = await searchPeople(
      apiKey,
      company.domain,
      perPage,
      undefined,
      titles,
      [],
      context,
      companyId,
    );
  }

  // Empty-result fallback: generic decision-makers — never an empty picker.
  if (people.length === 0) {
    usedFallback = true;
    people = await runSearch(fallbackTitles(sector, config));
  }

  const existingRows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId));
  const existingApolloIds = new Set(
    existingRows.map((c) => c.apolloId).filter(Boolean) as string[],
  );
  const existingLinkedIn = new Set(
    existingRows
      .map((c) => c.linkedinUrl?.trim().toLowerCase().replace(/\/+$/, ""))
      .filter(Boolean) as string[],
  );

  // De-duplicate + cap so one search can't balloon the candidate list.
  const maxCandidates = config.discovery.max_candidates;
  const seen = new Set<string>();
  const ranked = people
    .map((person) => ({
      person,
      rank: titlePriorityRank(String(person.title ?? ""), sector, sizeBand),
      inMarket: personMatchesLocation(person, parsedLocations),
    }))
    .sort((a, b) => {
      if (a.inMarket !== b.inMarket) return a.inMarket ? -1 : 1;
      return a.rank - b.rank;
    });

  let inserted = 0;
  for (const { person, inMarket } of ranked) {
    if (inserted >= maxCandidates) break;
    const apolloId = String(person.id ?? "");
    if (!apolloId || seen.has(apolloId)) continue;
    seen.add(apolloId);
    if (existingApolloIds.has(apolloId)) continue;
    const linkedinUrl = person.linkedin_url ? String(person.linkedin_url) : null;
    const linkedinKey = linkedinUrl?.trim().toLowerCase().replace(/\/+$/, "");
    if (linkedinKey && existingLinkedIn.has(linkedinKey)) continue;

    const first = String(person.first_name ?? "");
    const last = String(person.last_name ?? person.last_name_obfuscated ?? "");
    const name = String(person.name ?? `${first} ${last}`.trim());
    if (!name.trim()) continue;

    // Discovered candidate: NO email, NO phone — zero reveal credits spent.
    await db.insert(contacts).values({
      companyId,
      name,
      title: person.title ? String(person.title) : null,
      linkedinUrl,
      apolloId,
      sourceProvider: "apollo_discovery",
      revealStatus: "discovered",
      locationMatched: inMarket,
      contactLocation: formatPersonLocation(person),
      jobLocation: jobLocationLabel,
    });
    inserted += 1;
  }

  await db
    .update(companies)
    .set({ discoveryCompletedAt: new Date(), updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.companyId, companyId));
  const candidates = sortCandidates(
    rows.map((c) => candidateFromContact(c, sector, sizeBand)),
  );

  // Pre-select the best contact: highest-priority in-market candidate.
  const best = candidates.find((c) => c.revealStatus !== "legacy") ?? candidates[0];
  if (best && !rows.some((r) => r.isPrimary)) {
    await db
      .update(contacts)
      .set({ isPrimary: true })
      .where(eq(contacts.id, best.contactId));
    best.isPrimary = true;
  }

  return {
    candidates,
    cached: false,
    sector,
    sizeBand,
    usedUnion,
    usedFallback,
    searchesSpent,
  };
}

export type RevealSelection = {
  contactId: string;
  /** Phone is opt-in per contact — the scarcest credit. */
  channels: "email" | "email_phone";
};

export type RevealResult = {
  revealed: number;
  skippedAlreadyRevealed: number;
  emailsFound: number;
  phonesFound: number;
};

/**
 * Reveal — paid, per selection only. Spends Apollo match (and ContactOut when
 * phone is requested) on the CHOSEN contacts; never re-reveals a contact.
 */
export async function revealSelectedContacts(options: {
  companyId: string;
  selections: RevealSelection[];
  apiKey: string;
  contactOutApiKey?: string;
  contactOutAvailable?: boolean;
  context: PaidEgressContext;
}): Promise<RevealResult> {
  const {
    companyId,
    selections,
    apiKey,
    contactOutApiKey,
    contactOutAvailable = false,
    context,
  } = options;

  const ids = selections.map((s) => s.contactId);
  if (!ids.length) {
    return { revealed: 0, skippedAlreadyRevealed: 0, emailsFound: 0, phonesFound: 0 };
  }

  const rows = await db
    .select()
    .from(contacts)
    .where(inArray(contacts.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));

  let revealed = 0;
  let skippedAlreadyRevealed = 0;
  let emailsFound = 0;
  let phonesFound = 0;

  for (const selection of selections) {
    const contact = byId.get(selection.contactId);
    if (!contact || contact.companyId !== companyId) continue;

    // NEVER re-reveal: already-revealed (or already-callable legacy) contacts
    // are free to view and never re-charged.
    const alreadyCallable = Boolean(
      contact.email || contact.workEmail || contact.personalEmail,
    );
    const wantsPhone = selection.channels === "email_phone";
    const alreadyHasPhone = Boolean(contact.phone || contact.personalPhone);
    if (
      contact.revealStatus === "revealed" &&
      (!wantsPhone || alreadyHasPhone)
    ) {
      skippedAlreadyRevealed += 1;
      continue;
    }
    if (alreadyCallable && (!wantsPhone || alreadyHasPhone)) {
      skippedAlreadyRevealed += 1;
      if (contact.revealStatus !== "revealed") {
        await db
          .update(contacts)
          .set({
            revealStatus: "revealed",
            revealChannels: alreadyHasPhone ? "email_phone" : "email",
          })
          .where(eq(contacts.id, contact.id));
      }
      continue;
    }

    if (!contact.apolloId) continue;

    const useContactOutPhone =
      wantsPhone && Boolean(contactOutApiKey) && contactOutAvailable;
    const enriched = await matchPerson(
      apiKey,
      contact.apolloId,
      wantsPhone && !useContactOutPhone,
      context,
      companyId,
    );
    if (!enriched) continue;

    const emailRaw = enriched.email ? String(enriched.email) : null;
    let workEmail =
      contact.workEmail ??
      (emailRaw && !isPersonalEmail(emailRaw) ? emailRaw : null);
    let personalEmail =
      contact.personalEmail ??
      (emailRaw && isPersonalEmail(emailRaw) ? emailRaw : null);
    let phones = mergeSourcedPhones(
      contact.phones ?? [],
      wantsPhone ? extractApolloPhones(enriched) : [],
    );

    const linkedinUrl =
      contact.linkedinUrl ??
      (enriched.linkedin_url ? String(enriched.linkedin_url) : null);

    if (useContactOutPhone && linkedinUrl && contactOutApiKey) {
      const co = await enrichFromContactOut(
        linkedinUrl,
        contactOutApiKey,
        { needPhone: true, needPersonalEmail: !personalEmail },
        context,
        companyId,
      );
      if (co?.phoneApiLocked) {
        await markContactOutCreditsExhausted();
      } else if (co) {
        phones = mergeSourcedPhones(phones, co.phones);
        if (co.personalEmail && !personalEmail) personalEmail = co.personalEmail;
        if (co.workEmail && !workEmail) workEmail = co.workEmail;
      }
    }

    const normalized = normalizeContactChannels({
      workEmail,
      personalEmail,
      email: personalEmail ?? workEmail,
      phones,
    });

    await db
      .update(contacts)
      .set({
        email: normalized.email,
        workEmail: normalized.workEmail,
        personalEmail: normalized.personalEmail,
        phone: normalized.phone,
        personalPhone: normalized.personalPhone,
        companyPhone: normalized.companyPhone,
        phones: normalized.phones,
        linkedinUrl,
        title: contact.title || String(enriched.title ?? "") || null,
        sourceProvider:
          contact.sourceProvider === "apollo_discovery"
            ? "apollo"
            : contact.sourceProvider,
        revealStatus: "revealed",
        revealChannels: selection.channels,
        contactLocation:
          contact.contactLocation ?? formatPersonLocation(enriched),
      })
      .where(eq(contacts.id, contact.id));

    revealed += 1;
    if (normalized.email || normalized.workEmail || normalized.personalEmail) {
      emailsFound += 1;
    }
    if (normalized.phone || normalized.personalPhone) phonesFound += 1;

    await new Promise((r) => setTimeout(r, 300));
  }

  return { revealed, skippedAlreadyRevealed, emailsFound, phonesFound };
}
