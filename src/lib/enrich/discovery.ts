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
  apolloWebhookConfigured,
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
  hasEmail: boolean;
  hasPersonalEmail: boolean;
  hasPhone: boolean;
  /** Saved, but ContactOut could still add a personal email / direct mobile. */
  refreshable: boolean;
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

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Apollo occasionally returns a company/license record as a "person" (e.g.
 * "Accrue License 28141 L", title Owner). Filter these so discovery surfaces
 * real decision-makers, not registry entities.
 */
function looksNonPersonal(
  person: Record<string, unknown>,
  companyNameKey: string,
): boolean {
  const first = String(person.first_name ?? "").trim();
  const last = String(
    person.last_name ?? person.last_name_obfuscated ?? "",
  ).trim();
  const full = norm(String(person.name ?? `${first} ${last}`));
  if (!full) return true;
  if (/\d/.test(full)) return true; // digits in a person name = record id
  if (/\b(license|licensing|llc|inc|corp|company|holdings|trust|estate)\b/.test(full)) {
    return true;
  }
  // Name is essentially the company name (the org's own entity record).
  if (companyNameKey && full.startsWith(companyNameKey.split(" ")[0]) &&
      full.replace(/[^a-z ]/g, "").includes(companyNameKey.split(" ")[0])) {
    // First token equals the company's first token AND there's no plausible
    // human last name — treat as the company entity.
    if (!last || last.length <= 2 || /\d/.test(last)) return true;
  }
  return false;
}

function candidateFromContact(
  contact: typeof contacts.$inferSelect,
  sector: string,
  sizeBand: SizeBand,
): DiscoveryCandidate {
  const hasEmail = Boolean(
    contact.email || contact.workEmail || contact.personalEmail,
  );
  const hasPersonalEmail = Boolean(contact.personalEmail);
  // Company/HQ lines don't count as a direct phone — the upgrade must stay
  // available until the contact has a personal/direct number.
  const hasPhone = Boolean(
    contact.personalPhone ||
      (contact.phones ?? []).some((p) => p.kind !== "company"),
  );
  const hasContactOutMobile = (contact.phones ?? []).some(
    (p) => p.source === "contactout" && p.kind !== "company",
  );
  const callable = hasEmail || hasPhone;
  const isDiscovered = contact.revealStatus === "discovered" || !hasEmail;
  const nameMasked = contact.name.includes("*");
  // A saved contact is refreshable when there's still something to fix:
  // ContactOut could add a personal email / a ContactOut cell (preferred over
  // an existing Apollo phone), or the stored name is still Apollo-obfuscated.
  const refreshable =
    !isDiscovered &&
    ((Boolean(contact.linkedinUrl) &&
      (!hasPersonalEmail || !hasContactOutMobile)) ||
      (nameMasked && Boolean(contact.apolloId)));
  return {
    hasEmail,
    hasPersonalEmail,
    hasPhone,
    refreshable,
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

  // Bounded search chain (same shape as the legacy waterfall so companies
  // that used to find contacts still do): domain-scoped allowlist search,
  // then without location narrowing, then by company name, then the generic
  // decision-maker fallback. Stops at the first hit; every step is gated,
  // logged, and reveal-off.
  let searchesSpent = 0;
  let usedFallback = false;

  async function searchByDomain(
    searchTitles: string[],
    locations: string[] | undefined,
  ) {
    if (!company.domain) return [];
    searchesSpent += 1;
    return searchPeople(
      apiKey,
      company.domain,
      perPage,
      locations,
      searchTitles,
      [],
      context,
      companyId,
    );
  }

  async function searchByName(
    searchTitles: string[],
    locations: string[] | undefined,
  ) {
    searchesSpent += 1;
    return searchPeopleByCompanyName(
      apiKey,
      company.name,
      perPage,
      locations,
      searchTitles,
      [],
      context,
      companyId,
    );
  }

  const localLocations = apolloLocations.length ? apolloLocations : undefined;

  let people = await searchByDomain(titles, localLocations);
  if (people.length === 0 && localLocations && company.domain) {
    // Multi-office firms: retry without location narrowing.
    people = await searchByDomain(titles, undefined);
  }
  if (people.length === 0) {
    // Domain misses (wrong/unverified domain): retry by company name.
    people = await searchByName(titles, undefined);
  }
  if (people.length === 0) {
    // Empty-result fallback: generic decision-makers — never an empty picker.
    usedFallback = true;
    const generic = fallbackTitles(sector, config);
    people = company.domain
      ? await searchByDomain(generic, undefined)
      : await searchByName(generic, undefined);
    if (people.length === 0 && company.domain) {
      people = await searchByName(generic, undefined);
    }
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
  const companyNameKey = norm(company.name).replace(
    /\b(inc|llc|llp|lp|corp|corporation|co|company|ltd|group|partners)\b/g,
    "",
  ).trim();
  const seen = new Set<string>();
  const ranked = people
    .map((person) => ({
      person,
      rank: titlePriorityRank(String(person.title ?? ""), sector, sizeBand),
      inMarket: personMatchesLocation(person, parsedLocations),
      junk: looksNonPersonal(person, companyNameKey),
    }))
    .sort((a, b) => {
      // Real people rank above non-person entities (license/company records).
      if (a.junk !== b.junk) return a.junk ? 1 : -1;
      if (a.inMarket !== b.inMarket) return a.inMarket ? -1 : 1;
      return a.rank - b.rank;
    });

  let inserted = 0;
  for (const { person, inMarket, junk } of ranked) {
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
    // Skip obvious non-person records (e.g. "Accrue License 28141 L" as Owner).
    if (junk) continue;

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
  /** Apollo phone reveals still in flight via webhook (arrive in seconds). */
  phonesPending: number;
  /** Whether the ContactOut leg of the waterfall ran for this reveal. */
  contactOutUsed: boolean;
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
    return {
      revealed: 0,
      skippedAlreadyRevealed: 0,
      emailsFound: 0,
      phonesFound: 0,
      phonesPending: 0,
      contactOutUsed: false,
    };
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
  let contactOutUsed = false;
  const pendingApolloPhoneIds: string[] = [];

  for (const selection of selections) {
    const contact = byId.get(selection.contactId);
    if (!contact || contact.companyId !== companyId) continue;

    const wantsPhone = selection.channels === "email_phone";
    const contactOutReady = Boolean(contactOutApiKey) && contactOutAvailable;

    // Current state — company/HQ lines are NOT a direct phone.
    const hasAnyEmail = Boolean(
      contact.email || contact.workEmail || contact.personalEmail,
    );
    const hasPersonalEmail = Boolean(contact.personalEmail);
    const hasDirectPhoneNow =
      Boolean(contact.personalPhone) ||
      (contact.phones ?? []).some((p) => p.kind !== "company");
    // ContactOut is the PREFERRED phone source. An existing Apollo phone does
    // NOT satisfy a phone request — we still fetch the ContactOut cell.
    const hasContactOutMobile = (contact.phones ?? []).some(
      (p) => p.source === "contactout" && p.kind !== "company",
    );
    // Apollo obfuscates last names in SEARCH results; the stored discovered
    // name contains "*" until a people/match reveals the real name.
    const nameMasked = contact.name.includes("*");

    // What can still be fetched this click? (never re-charges existing data)
    const needName = nameMasked && Boolean(contact.apolloId);
    const needEmail = !hasAnyEmail;
    const needPersonalEmail =
      !hasPersonalEmail && contactOutReady && Boolean(contact.linkedinUrl);
    // Phone is needed if we don't yet have a ContactOut cell (preferred), OR
    // — when ContactOut can't run — no direct phone at all.
    const needPhone =
      wantsPhone &&
      (contactOutReady && contact.linkedinUrl
        ? !hasContactOutMobile
        : !hasDirectPhoneNow);

    // NEVER re-reveal when there is genuinely nothing new to fetch.
    if (!needName && !needEmail && !needPersonalEmail && !needPhone) {
      skippedAlreadyRevealed += 1;
      if (hasAnyEmail && contact.revealStatus !== "revealed") {
        await db
          .update(contacts)
          .set({
            revealStatus: "revealed",
            revealChannels: hasDirectPhoneNow ? "email_phone" : "email",
          })
          .where(eq(contacts.id, contact.id));
      }
      continue;
    }

    if (!contact.apolloId && !contact.linkedinUrl) continue;

    const alreadyHasPhone = hasDirectPhoneNow;
    let revealedName = contact.name;

    /*
     * Legacy-faithful waterfall — the order that "worked before":
     *  1. Apollo people/match (email-only, 1 credit) when we still need the
     *     work email or a LinkedIn URL to feed ContactOut. Never requests the
     *     Apollo phone here while ContactOut is available.
     *  2. ContactOut (from the LinkedIn URL): personal email, missing work
     *     email, and — when the phone channel was selected — the mobile.
     *     This is the primary phone source.
     *  3. Apollo phone reveal ONLY as the last resort when phone was
     *     requested and ContactOut couldn't supply one (async via webhook —
     *     awaited below so the result isn't misreported as "not found").
     */
    let workEmail = contact.workEmail ?? null;
    let personalEmail = contact.personalEmail ?? null;
    let personalEmails = [...(contact.personalEmails ?? [])];
    let phones = contact.phones ?? [];
    let linkedinUrl = contact.linkedinUrl ?? null;
    let contactLocation = contact.contactLocation ?? null;
    let contactOutLocked = false;
    let apolloPhoneRequested = false;

    const hasDirectPhone = () =>
      alreadyHasPhone || phones.some((p) => p.kind !== "company");
    const hasContactOutMobileNow = () =>
      phones.some((p) => p.source === "contactout" && p.kind !== "company");

    /* Step 1 — Apollo email match: resolves the REAL full name (search results
     * obfuscate the last name), the work email, and the LinkedIn URL for CO.
     * Never requests the Apollo phone here when ContactOut can run (ContactOut
     * is the preferred cell source). */
    const contactOutCanRun = contactOutReady && Boolean(linkedinUrl);
    const needsApolloMatch =
      Boolean(contact.apolloId) && (!workEmail || !linkedinUrl || needName);
    if (needsApolloMatch && contact.apolloId) {
      const requestApolloPhone =
        wantsPhone && !hasDirectPhone() && !contactOutReady;
      if (requestApolloPhone) apolloPhoneRequested = true;
      const enriched = await matchPerson(
        apiKey,
        contact.apolloId,
        requestApolloPhone,
        context,
        companyId,
      );
      if (enriched) {
        // Un-mask the name from the match (real first + last name).
        const first = String(enriched.first_name ?? "").trim();
        const last = String(enriched.last_name ?? "").trim();
        const matchName = String(enriched.name ?? `${first} ${last}`).trim();
        if (matchName && !matchName.includes("*")) {
          revealedName = matchName;
        }
        const emailRaw = enriched.email ? String(enriched.email) : null;
        if (emailRaw && !isPersonalEmail(emailRaw) && !workEmail) {
          workEmail = emailRaw;
        }
        if (emailRaw && isPersonalEmail(emailRaw) && !personalEmail) {
          personalEmail = emailRaw;
        }
        if (requestApolloPhone) {
          phones = mergeSourcedPhones(phones, extractApolloPhones(enriched));
        }
        linkedinUrl =
          linkedinUrl ??
          (enriched.linkedin_url ? String(enriched.linkedin_url) : null);
        contactLocation = contactLocation ?? formatPersonLocation(enriched);
      }
    }

    /* Step 2 — ContactOut: the PRIMARY source for personal cell (top 3) and
     * personal email (top 2). Runs for the phone even when an Apollo phone
     * already exists, so we prefer the ContactOut cell. */
    if (contactOutReady && linkedinUrl && contactOutApiKey) {
      contactOutUsed = true;
      const co = await enrichFromContactOut(
        linkedinUrl,
        contactOutApiKey,
        {
          needPersonalEmail: personalEmails.length < 2,
          needWorkEmail: !workEmail,
          needPhone: wantsPhone && !hasContactOutMobileNow(),
        },
        context,
        companyId,
      );
      if (co?.phoneApiLocked) {
        contactOutLocked = true;
        await markContactOutCreditsExhausted();
      } else if (co) {
        phones = mergeSourcedPhones(phones, co.phones);
        for (const e of co.personalEmails) {
          if (!personalEmails.includes(e)) personalEmails.push(e);
        }
        if (co.personalEmail && !personalEmail) personalEmail = co.personalEmail;
        if (!personalEmail && personalEmails[0]) personalEmail = personalEmails[0];
        if (co.workEmail && !workEmail) workEmail = co.workEmail;
      }
    }

    /* Step 3 — Apollo phone reveal, last resort (webhook-async): fires only
     * when phone was requested and ContactOut couldn't supply a cell (no
     * LinkedIn URL, locked, or no ContactOut mobile found). */
    if (
      wantsPhone &&
      !hasDirectPhone() &&
      contact.apolloId &&
      !apolloPhoneRequested
    ) {
      apolloPhoneRequested = true;
      const enriched = await matchPerson(
        apiKey,
        contact.apolloId,
        true,
        context,
        companyId,
      );
      if (enriched) {
        phones = mergeSourcedPhones(phones, extractApolloPhones(enriched));
      }
    }

    const normalized = normalizeContactChannels({
      workEmail,
      personalEmail,
      email: personalEmail ?? workEmail,
      phones,
    });
    // Keep up to 2 personal emails, primary first.
    const finalPersonalEmails = [
      ...new Set(
        [normalized.personalEmail, ...personalEmails].filter(
          (e): e is string => Boolean(e),
        ),
      ),
    ].slice(0, 2);

    const gotContactOutData =
      contactOutUsed &&
      !contactOutLocked &&
      Boolean(personalEmail || normalized.phones.length);

    await db
      .update(contacts)
      .set({
        name: revealedName,
        email: normalized.email,
        workEmail: normalized.workEmail,
        personalEmail: normalized.personalEmail,
        personalEmails: finalPersonalEmails,
        phone: normalized.phone,
        personalPhone: normalized.personalPhone,
        companyPhone: normalized.companyPhone,
        phones: normalized.phones,
        linkedinUrl,
        contactLocation,
        // Upgrade the provider label whenever ContactOut contributed — this is
        // how an Apollo-only saved contact becomes apollo+contactout on refresh.
        sourceProvider: gotContactOutData
          ? "apollo+contactout"
          : contact.sourceProvider === "apollo_discovery"
            ? "apollo"
            : contact.sourceProvider,
        revealStatus: "revealed",
        // Keep the widest channel set paid for across reveals (email → phone upgrade).
        revealChannels:
          selection.channels === "email_phone" ||
          contact.revealChannels === "email_phone"
            ? "email_phone"
            : "email",
      })
      .where(eq(contacts.id, contact.id));

    revealed += 1;
    if (normalized.email || normalized.workEmail || normalized.personalEmail) {
      emailsFound += 1;
    }
    if (normalized.phone || normalized.personalPhone) {
      phonesFound += 1;
    } else if (apolloPhoneRequested && apolloWebhookConfigured()) {
      // Apollo delivers revealed phones ASYNC via webhook — don't report
      // "not found" while the number is still in flight.
      pendingApolloPhoneIds.push(contact.id);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Wait briefly for the Apollo phone webhook (same as the legacy enrich),
  // then re-read: numbers that landed count as found, not pending.
  let phonesPending = 0;
  if (pendingApolloPhoneIds.length) {
    await new Promise((r) => setTimeout(r, 5000));
    const refreshed = await db
      .select()
      .from(contacts)
      .where(inArray(contacts.id, pendingApolloPhoneIds));
    for (const contact of refreshed) {
      if (contact.phone || contact.personalPhone) {
        phonesFound += 1;
      } else {
        phonesPending += 1;
      }
    }
  }

  return {
    revealed,
    skippedAlreadyRevealed,
    emailsFound,
    phonesFound,
    phonesPending,
    contactOutUsed,
  };
}
