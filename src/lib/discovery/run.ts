/**
 * Company-first discovery run.
 *
 * Select market + vertical → find N companies from Apollo organization search
 * → qualify → attach job signals → hand to the operator's review queue.
 *
 * Cost discipline: organization search is 1 credit per page of up to 100
 * organizations and reveals nobody. NOTHING in this file spends a reveal
 * credit — paid people data starts only when the operator clicks Approve for
 * Enrichment.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  companyDiscoveryRuns,
  companyIcp,
  jobListings,
} from "@/lib/db/schema";
import { normalizeCompanyKey } from "@/lib/company-name";
import { searchOrganizations } from "@/lib/domain-resolver";
import { evaluateIcp } from "@/lib/icp-filter";
import { annotateCompaniesIcp } from "@/lib/icp/icp-annotate";
import { HARD_EXCLUDE_FLAGS_BY_TOGGLE } from "@/lib/icp/icp-scorer";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import { manualEnrichContext, type PaidEgressContext } from "@/lib/paid-egress";
import { businessListDate } from "@/lib/timezone";
import {
  candidateKey,
  selectDiscoveryCandidates,
  type DiscoveryCandidate,
} from "./candidates";
import { summarizeJobSignals, type JobSignalSummary } from "./job-signals";
import {
  advanceCursor,
  EMPTY_CURSOR,
  pageForCursor,
  poolStatus,
  type DiscoveryCursor,
  type DiscoveryPool,
  type PoolStatus,
} from "./pagination";
import {
  apolloEmployeeRange,
  getVerticalConfig,
  keywordTagsForVertical,
} from "./verticals";

/**
 * The unknown-headcount pass pages at Apollo's maximum: companies Apollo has no
 * headcount for are a minority of any page, and a page costs the same one
 * credit whether it holds 25 rows or 100.
 */
const UNKNOWN_SIZE_PER_PAGE = 100;

/** Deterministic flags that mean "the operator never wants to see this". */
const AUTO_EXCLUDE_FLAGS = new Set(
  Object.values(HARD_EXCLUDE_FLAGS_BY_TOGGLE).flatMap((flags) => flags ?? []),
);

export type DiscoveryRunResultCompany = {
  id: string;
  name: string;
  domain: string | null;
  estimatedEmployees: number | null;
  sizeUnknown: boolean;
  created: boolean;
  autoExcluded: boolean;
  jobSignal: JobSignalSummary;
};

export type DiscoveryRunSummary = {
  vertical: string;
  verticalLabel: string;
  market: string;
  limit: number;
  creditsSpent: number;
  returnedSized: number;
  returnedUnknownSize: number;
  companiesReviewed: number;
  created: number;
  updated: number;
  duplicatesSkipped: number;
  sizeUnknownCount: number;
  autoExcluded: number;
  withJobSignals: number;
  pools: Record<DiscoveryPool, PoolStatus>;
  poolExhausted: boolean;
  notes: string[];
  companies: DiscoveryRunResultCompany[];
};

async function loadCursor(
  vertical: string,
  market: string,
  pool: DiscoveryPool,
): Promise<DiscoveryCursor> {
  const [row] = await db
    .select()
    .from(companyDiscoveryRuns)
    .where(
      sql`${companyDiscoveryRuns.vertical} = ${vertical}
        AND ${companyDiscoveryRuns.market} = ${market}
        AND ${companyDiscoveryRuns.pool} = ${pool}`,
    )
    .limit(1);
  if (!row) return { ...EMPTY_CURSOR };
  return {
    perPage: row.perPage,
    consumed: row.consumed,
    totalEntries: row.totalEntries,
    poolExhausted: row.poolExhausted,
  };
}

async function saveCursor(
  vertical: string,
  market: string,
  pool: DiscoveryPool,
  cursor: DiscoveryCursor,
  lastReturned: number,
): Promise<void> {
  await db
    .insert(companyDiscoveryRuns)
    .values({
      vertical,
      market,
      pool,
      perPage: cursor.perPage,
      consumed: cursor.consumed,
      totalEntries: cursor.totalEntries,
      pagesFetched: 1,
      poolExhausted: cursor.poolExhausted,
      lastRunAt: new Date(),
      lastReturned,
    })
    .onConflictDoUpdate({
      target: [
        companyDiscoveryRuns.vertical,
        companyDiscoveryRuns.market,
        companyDiscoveryRuns.pool,
      ],
      set: {
        perPage: cursor.perPage,
        consumed: cursor.consumed,
        totalEntries: cursor.totalEntries,
        pagesFetched: sql`${companyDiscoveryRuns.pagesFetched} + 1`,
        poolExhausted: cursor.poolExhausted,
        lastRunAt: new Date(),
        lastReturned,
        updatedAt: new Date(),
      },
    });
}

/** Pool status for every (vertical, market) the operator has already run. */
export async function getDiscoveryPoolStatuses(): Promise<
  Array<{
    vertical: string;
    market: string;
    pool: DiscoveryPool;
    status: PoolStatus;
    lastRunAt: Date | null;
  }>
> {
  const rows = await db.select().from(companyDiscoveryRuns);
  return rows.map((row) => ({
    vertical: row.vertical,
    market: row.market,
    pool: row.pool === "unknown_size" ? "unknown_size" : "sized",
    lastRunAt: row.lastRunAt,
    status: poolStatus({
      perPage: row.perPage,
      consumed: row.consumed,
      totalEntries: row.totalEntries,
      poolExhausted: row.poolExhausted,
    }),
  }));
}

type ExistingCompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  status: string;
  vertical: string | null;
  reviewStatus: string | null;
  domainConfidence: "high" | "low";
  industry: string | null;
  estimatedEmployees: number | null;
  phone: string | null;
  linkedinUrl: string | null;
  city: string | null;
  state: string | null;
};

/**
 * Dedupe index over every existing company: domain first (the UNIQUE column),
 * then normalised name — Postgres nulls never collide, so a domain-less company
 * from the scrape can only be matched by name.
 */
async function buildDedupeIndex(): Promise<{
  byDomain: Map<string, ExistingCompanyRow>;
  byName: Map<string, ExistingCompanyRow>;
}> {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      status: companies.status,
      vertical: companies.vertical,
      reviewStatus: companies.reviewStatus,
      domainConfidence: companies.domainConfidence,
      industry: companies.industry,
      estimatedEmployees: companies.estimatedEmployees,
      phone: companies.phone,
      linkedinUrl: companies.linkedinUrl,
      city: companies.city,
      state: companies.state,
    })
    .from(companies);

  const byDomain = new Map<string, ExistingCompanyRow>();
  const byName = new Map<string, ExistingCompanyRow>();
  for (const row of rows) {
    const typed = row as ExistingCompanyRow;
    const domain = row.domain?.trim().toLowerCase();
    if (domain && !byDomain.has(domain)) byDomain.set(domain, typed);
    const nameKey = normalizeCompanyKey(row.name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, typed);
  }
  return { byDomain, byName };
}

export function matchExistingCompany(
  candidate: { name: string; domain: string | null },
  index: {
    byDomain: Map<string, ExistingCompanyRow>;
    byName: Map<string, ExistingCompanyRow>;
  },
): ExistingCompanyRow | null {
  const domain = candidate.domain?.trim().toLowerCase();
  if (domain) {
    const hit = index.byDomain.get(domain);
    if (hit) return hit;
  }
  const nameKey = normalizeCompanyKey(candidate.name);
  if (!nameKey) return null;
  return index.byName.get(nameKey) ?? null;
}

async function upsertCandidate(
  candidate: DiscoveryCandidate,
  vertical: string,
  market: string,
  index: {
    byDomain: Map<string, ExistingCompanyRow>;
    byName: Map<string, ExistingCompanyRow>;
  },
): Promise<{ id: string; created: boolean }> {
  const domain = candidate.domain?.trim().toLowerCase() || null;
  const existing = matchExistingCompany(candidate, index);
  const icpStatus = evaluateIcp({
    companyName: candidate.name,
    estimatedEmployees: candidate.estimatedEmployees,
    vertical,
  });

  if (existing) {
    // Never overwrite what the pipeline already knows; only fill the blanks.
    // Review state is left alone once the company has moved past 'new' so a
    // discovery hit can't drag a contacted company back into the queue.
    const takeReviewStatus =
      existing.reviewStatus == null && existing.status === "new";
    await db
      .update(companies)
      .set({
        domain: existing.domain ?? domain,
        domainConfidence:
          existing.domainConfidence === "high"
            ? "high"
            : domain
              ? candidate.domainConfidence
              : existing.domainConfidence,
        industry: existing.industry ?? candidate.industry,
        estimatedEmployees:
          existing.estimatedEmployees ?? candidate.estimatedEmployees,
        phone: existing.phone ?? candidate.phone,
        linkedinUrl: existing.linkedinUrl ?? candidate.linkedinUrl,
        city: existing.city ?? candidate.city,
        state: existing.state ?? candidate.state,
        vertical: existing.vertical ?? vertical,
        ...(takeReviewStatus
          ? { reviewStatus: "pending" as const, reviewStatusUpdatedAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(companies.id, existing.id));
    return { id: existing.id, created: false };
  }

  const [row] = await db
    .insert(companies)
    .values({
      name: candidate.name,
      domain,
      domainConfidence: candidate.domainConfidence,
      firstSeen: businessListDate(),
      industry: candidate.industry,
      estimatedEmployees: candidate.estimatedEmployees,
      phone: candidate.phone,
      linkedinUrl: candidate.linkedinUrl,
      vertical,
      city: candidate.city,
      state: candidate.state,
      reviewStatus: "pending",
      reviewStatusUpdatedAt: new Date(),
      icpStatus,
      sourceMarket: market,
    })
    // domain is UNIQUE: a company already present from the job scrape must be
    // updated, not collided with.
    .onConflictDoUpdate({
      target: companies.domain,
      set: {
        vertical,
        phone: sql`COALESCE(${companies.phone}, ${candidate.phone})`,
        linkedinUrl: sql`COALESCE(${companies.linkedinUrl}, ${candidate.linkedinUrl})`,
        city: sql`COALESCE(${companies.city}, ${candidate.city})`,
        state: sql`COALESCE(${companies.state}, ${candidate.state})`,
        industry: sql`COALESCE(${companies.industry}, ${candidate.industry})`,
        estimatedEmployees: sql`COALESCE(${companies.estimatedEmployees}, ${candidate.estimatedEmployees})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: companies.id });

  return { id: row.id, created: true };
}

export type DiscoveryRunOptions = {
  vertical: string;
  market: string;
  limit: number;
  includeUnknownSize?: boolean;
  apiKey: string;
  context?: PaidEgressContext;
};

export async function runCompanyDiscovery(
  options: DiscoveryRunOptions,
): Promise<DiscoveryRunSummary> {
  const { vertical, market, apiKey } = options;
  const verticalConfig = getVerticalConfig(vertical);
  if (!verticalConfig) throw new Error(`Unknown vertical: ${vertical}`);

  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), 100);
  const includeUnknownSize = options.includeUnknownSize !== false;
  const context =
    options.context ?? manualEnrichContext(`discovery:${vertical}:${market}`);
  const notes: string[] = [];

  const sizedCursor = await loadCursor(vertical, market, "sized");
  const unknownCursor = await loadCursor(vertical, market, "unknown_size");

  let creditsSpent = 0;
  const sizedPage = pageForCursor(sizedCursor, limit);
  const sizedResult = await searchOrganizations({
    apiKey,
    locations: [market],
    keywordTags: keywordTagsForVertical(vertical),
    employeeRange: apolloEmployeeRange(vertical),
    page: sizedPage,
    perPage: limit,
    context,
    usageLabel: `discovery:${vertical}:${market}:sized`,
  });
  creditsSpent += 1;

  let unknownOrganizations: typeof sizedResult.organizations = [];
  let unknownReturned = 0;
  let nextUnknownCursor = unknownCursor;
  if (includeUnknownSize && !unknownCursor.poolExhausted) {
    const unknownPage = pageForCursor(unknownCursor, UNKNOWN_SIZE_PER_PAGE);
    const unknownResult = await searchOrganizations({
      apiKey,
      locations: [market],
      keywordTags: keywordTagsForVertical(vertical),
      employeeRange: null,
      page: unknownPage,
      perPage: UNKNOWN_SIZE_PER_PAGE,
      context,
      usageLabel: `discovery:${vertical}:${market}:unknown_size`,
    });
    creditsSpent += 1;
    unknownOrganizations = unknownResult.organizations;
    unknownReturned = unknownResult.organizations.length;
    nextUnknownCursor = advanceCursor(unknownCursor, {
      requested: UNKNOWN_SIZE_PER_PAGE,
      returned: unknownReturned,
      totalEntries: unknownResult.totalEntries,
      perPage: UNKNOWN_SIZE_PER_PAGE,
    });
    notes.push(
      "Unknown-headcount pass ran: Apollo's employee-range filter hides companies " +
        "it has no headcount for, so those are searched separately and flagged " +
        "size unknown (1 extra credit).",
    );
  } else if (includeUnknownSize) {
    notes.push(
      "Unknown-headcount pool already exhausted for this market — skipped.",
    );
  }

  const nextSizedCursor = advanceCursor(sizedCursor, {
    requested: limit,
    returned: sizedResult.organizations.length,
    totalEntries: sizedResult.totalEntries,
    perPage: limit,
  });

  const { candidates, duplicatesSkipped, sizeUnknownCount } =
    selectDiscoveryCandidates({
      vertical,
      sized: sizedResult.organizations,
      unknownSize: unknownOrganizations,
      limit,
    });

  const index = await buildDedupeIndex();
  const upserted: Array<{
    candidate: DiscoveryCandidate;
    id: string;
    created: boolean;
  }> = [];
  let alreadyKnown = 0;
  for (const candidate of candidates) {
    const { id, created } = await upsertCandidate(
      candidate,
      vertical,
      market,
      index,
    );
    if (!created) alreadyKnown += 1;
    upserted.push({ candidate, id, created });
    // Keep the in-run index current so two Apollo rows for one company
    // (e.g. domain-less duplicates) can't insert twice.
    const key = candidateKey(candidate);
    if (key.startsWith("domain:")) {
      index.byDomain.set(key.slice("domain:".length), {
        id,
        name: candidate.name,
        domain: candidate.domain,
        status: "new",
        vertical,
        reviewStatus: "pending",
        domainConfidence: candidate.domainConfidence,
        industry: candidate.industry,
        estimatedEmployees: candidate.estimatedEmployees,
        phone: candidate.phone,
        linkedinUrl: candidate.linkedinUrl,
        city: candidate.city,
        state: candidate.state,
      });
    }
    const nameKey = normalizeCompanyKey(candidate.name);
    if (nameKey && !index.byName.has(nameKey)) {
      index.byName.set(nameKey, {
        id,
        name: candidate.name,
        domain: candidate.domain,
        status: "new",
        vertical,
        reviewStatus: "pending",
        domainConfidence: candidate.domainConfidence,
        industry: candidate.industry,
        estimatedEmployees: candidate.estimatedEmployees,
        phone: candidate.phone,
        linkedinUrl: candidate.linkedinUrl,
        city: candidate.city,
        state: candidate.state,
      });
    }
  }

  const ids = upserted.map((u) => u.id);

  // Job signals: listings already scraped for these companies (the dedupe above
  // is what links a discovered company to its existing postings).
  const listingRows = ids.length
    ? await db
        .select({
          companyId: jobListings.companyId,
          title: jobListings.title,
          postedAt: jobListings.postedAt,
          firstSeenAt: jobListings.firstSeenAt,
          archivedAt: jobListings.archivedAt,
        })
        .from(jobListings)
        .where(inArray(jobListings.companyId, ids))
    : [];
  const listingsByCompany = new Map<string, typeof listingRows>();
  for (const row of listingRows) {
    const list = listingsByCompany.get(row.companyId) ?? [];
    list.push(row);
    listingsByCompany.set(row.companyId, list);
  }

  // Annotate → score → annotate: the ICP adjusted score multiplies the lead
  // score, and the company-first lead score reads the exclusion flags, so each
  // needs the other's first pass.
  if (ids.length) {
    try {
      await annotateCompaniesIcp(ids);
      await recomputeCompanyScores(ids);
      await annotateCompaniesIcp(ids);
    } catch (err) {
      // Scoring must never lose a discovered company.
      console.error("Discovery ICP/scoring pass failed:", err);
      notes.push("ICP annotation or scoring failed — companies kept unscored.");
    }
  }

  const icpRows = ids.length
    ? await db
        .select({
          companyId: companyIcp.companyId,
          flags: companyIcp.exclusionFlags,
        })
        .from(companyIcp)
        .where(inArray(companyIcp.companyId, ids))
    : [];
  const flagsByCompany = new Map(
    icpRows.map((row) => [row.companyId, row.flags ?? []]),
  );

  // Deterministic exclusions (Fortune lists, .gov, known staffing agencies,
  // known large private) are rejected up front — that noise is the reason the
  // operator wanted company-first discovery in the first place.
  const autoExcludedIds: string[] = [];
  for (const { id } of upserted) {
    const flags = flagsByCompany.get(id) ?? [];
    if (flags.some((flag) => AUTO_EXCLUDE_FLAGS.has(flag))) {
      autoExcludedIds.push(id);
    }
  }
  if (autoExcludedIds.length) {
    await db
      .update(companies)
      .set({
        reviewStatus: "rejected",
        reviewStatusUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(companies.id, autoExcludedIds));
    notes.push(
      `${autoExcludedIds.length} auto-rejected on deterministic exclusion flags ` +
        "(Fortune list, .gov, known staffing agency, known large private).",
    );
  }

  await saveCursor(
    vertical,
    market,
    "sized",
    nextSizedCursor,
    sizedResult.organizations.length,
  );
  if (includeUnknownSize && !unknownCursor.poolExhausted) {
    await saveCursor(
      vertical,
      market,
      "unknown_size",
      nextUnknownCursor,
      unknownReturned,
    );
  }

  const pools: Record<DiscoveryPool, PoolStatus> = {
    sized: poolStatus(nextSizedCursor),
    unknown_size: poolStatus(nextUnknownCursor),
  };
  if (pools.sized.exhausted) {
    notes.push(
      `Sized pool exhausted for ${verticalConfig.label} in ${market} — rotate market.`,
    );
  }
  if (sizeUnknownCount) {
    notes.push(
      `${sizeUnknownCount} company/companies have no Apollo headcount — shown as "size unknown", not filtered out.`,
    );
  }
  if (duplicatesSkipped) {
    notes.push(
      `${duplicatesSkipped} duplicate result(s) from Apollo skipped before review.`,
    );
  }
  if (alreadyKnown) {
    notes.push(
      `${alreadyKnown} already existed in the pipeline (matched on domain or name) and were enriched in place.`,
    );
  }

  const resultCompanies: DiscoveryRunResultCompany[] = upserted.map(
    ({ candidate, id, created }) => ({
      id,
      name: candidate.name,
      domain: candidate.domain,
      estimatedEmployees: candidate.estimatedEmployees,
      sizeUnknown: candidate.sizeUnknown,
      created,
      autoExcluded: autoExcludedIds.includes(id),
      jobSignal: summarizeJobSignals(listingsByCompany.get(id) ?? []),
    }),
  );

  return {
    vertical,
    verticalLabel: verticalConfig.label,
    market,
    limit,
    creditsSpent,
    returnedSized: sizedResult.organizations.length,
    returnedUnknownSize: unknownReturned,
    companiesReviewed: resultCompanies.length,
    created: resultCompanies.filter((c) => c.created).length,
    updated: alreadyKnown,
    duplicatesSkipped,
    sizeUnknownCount,
    autoExcluded: autoExcludedIds.length,
    withJobSignals: resultCompanies.filter((c) => c.jobSignal.openPositions > 0)
      .length,
    pools,
    poolExhausted: pools.sized.exhausted,
    notes,
    companies: resultCompanies,
  };
}
