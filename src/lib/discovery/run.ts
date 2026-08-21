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

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  companyDiscoveryRuns,
  companyIcp,
  jobListings,
} from "@/lib/db/schema";
import { companyNameKeyStrength, normalizeCompanyKey } from "@/lib/company-name";
import {
  searchOrganizations,
  type DiscoveredOrganization,
} from "@/lib/domain-resolver";
import { evaluateIcp } from "@/lib/icp-filter";
import { annotateCompaniesIcp } from "@/lib/icp/icp-annotate";
import { HARD_EXCLUDE_FLAGS_BY_TOGGLE } from "@/lib/icp/icp-scorer";
import {
  allSectorFilterOptions,
  isCoarseSectorRollup,
} from "@/lib/industry-sectors";
import { recomputeCompanyScores } from "@/lib/recompute-company-scores";
import { manualEnrichContext, type PaidEgressContext } from "@/lib/paid-egress";
import { businessListDate } from "@/lib/timezone";
import {
  candidateKey,
  selectDiscoveryCandidates,
  type DiscoveryCandidate,
} from "./candidates";
import {
  describeGateRejections,
  partitionByGate,
  summarizeGateReasons,
  type GateDecision,
} from "./exclusion-gate";
import { summarizeJobSignals, type JobSignalSummary } from "./job-signals";
import {
  advanceCursor,
  DISCOVERY_APOLLO_PER_PAGE,
  EMPTY_CURSOR,
  pageForCursor,
  poolStatus,
  reconcileCursor,
  type DiscoveryCursor,
  type DiscoveryPool,
  type PoolStatus,
} from "./pagination";
import {
  apolloEmployeeRange,
  getVerticalConfig,
  keywordTagsForVertical,
} from "./verticals";
import { resolveSupplementarySources } from "./sources/source";
import {
  gateInputFor,
  headcountProvenance,
  quantifyOrganizations,
  type FieldProvenance,
} from "./sources/apollo-quantify";

/**
 * Both Apollo passes page at Apollo's maximum: a page costs the same one credit
 * whether it holds 25 rows or 100, so asking for the run's `limit` (25 by
 * default) threw away three quarters of what the credit had already paid for.
 *
 * Decoupling page size from the requested limit is what makes the batch survive
 * filtering. `selectDiscoveryCandidates` slices to `limit` at the end, so the
 * extra rows are the depth that dedupe and the exclusion gate draw from — with
 * 25 rows in hand, a run where half the page is already known or out of band
 * returns twelve companies; with 100 it returns the twenty-five asked for. It
 * also advances the cursor four times faster, so "pool exhausted, rotate
 * market" becomes an honest signal instead of one that arrives months late.
 *
 * The one cost: on the first run after this change, a cursor whose `consumed`
 * was accumulated at 25 rows a page lands mid-page on the 100-row grid and a
 * few organizations repeat. Dedupe absorbs them and the summary reports them as
 * duplicates.
 */
const APOLLO_PER_PAGE = DISCOVERY_APOLLO_PER_PAGE;

/** Deterministic flags that mean "the operator never wants to see this". */
const AUTO_EXCLUDE_FLAGS = new Set(
  Object.values(HARD_EXCLUDE_FLAGS_BY_TOGGLE).flatMap((flags) => flags ?? []),
);

/**
 * Apply the exclusion gate to a raw provider page, BEFORE dedupe and before
 * anything is written. Rejected companies are never inserted, so they cannot
 * reach the review queue at a lower rank the way an ICP score penalty allowed.
 * They are counted by reason instead, which is what makes a short run
 * diagnosable.
 */
export function gateOrganizations<T extends DiscoveredOrganization>(
  organizations: T[],
  vertical: string,
  allowLargeCompanies = false,
): { kept: T[]; rejected: GateDecision[] } {
  const partition = partitionByGate(
    organizations,
    (org) => ({
      // `gateInputFor` is what hands the gate Apollo's INDUSTRY TAXONOMY rather
      // than the display label, and building the input inline here instead is a
      // fail-open: a staffing agency whose Google Business category reads
      // "Business management consultant" keeps that label under display
      // precedence, which hides Apollo's "staffing & recruiting" from the gate.
      ...gateInputFor(org, vertical),
      // The enterprise-domain rule still needs something to match on, and a
      // Maps row can carry a website without a resolved primary domain.
      domain: org.domain ?? org.websiteUrl,
    }),
    { allowLargeCompanies },
  );
  return {
    kept: [...partition.accepted, ...partition.flagged.map((f) => f.item)],
    rejected: partition.rejected.map((r) => r.decision),
  };
}

export type DiscoveryRunResultCompany = {
  id: string;
  name: string;
  domain: string | null;
  estimatedEmployees: number | null;
  sizeUnknown: boolean;
  /**
   * Who supplied the headcount: `apollo` when the quantify step backfilled it,
   * `source` when the discovering source already knew it, `unknown` when nobody
   * does. Reported separately from `sizeUnknown` because "Apollo says 18" and
   * "nobody knows" must never read the same — one is decided, the other needs a
   * human, and conflating them is the fail-open behaviour the exclusion gate
   * exists to prevent.
   */
  sizeSource: FieldProvenance;
  created: boolean;
  autoExcluded: boolean;
  jobSignal: JobSignalSummary;
};

/**
 * What each non-Apollo source contributed, so the operator can see whether a
 * supplementary source is earning its searches — and, when one is off or capped,
 * why it contributed nothing.
 */
export type DiscoverySourceReport = {
  name: string;
  billingUnit: "credit" | "search";
  unitsSpent: number;
  returned: number;
  rejected: Record<string, number>;
  poolExhausted: boolean;
};

export type DiscoveryRunSummary = {
  vertical: string;
  verticalLabel: string;
  market: string;
  limit: number;
  /** Every Apollo credit this run spent: both search passes plus quantify. */
  creditsSpent: number;
  /**
   * The quantify share of `creditsSpent`, broken out so the operator can see
   * what backfilling company attributes cost separately from searching, and so
   * a change in one is never mistaken for a change in the other.
   */
  apolloQuantifyCredits: number;
  /** Per-source accounting for every supplementary source that ran. */
  sources: DiscoverySourceReport[];
  /** Supplementary sources that did not run, and why. */
  sourcesSkipped: Array<{ name: string; reason: string }>;
  returnedSized: number;
  returnedUnknownSize: number;
  companiesReviewed: number;
  created: number;
  updated: number;
  duplicatesSkipped: number;
  sizeUnknownCount: number;
  autoExcluded: number;
  /** Companies the exclusion gate refused before anything was written. */
  gateRejected: number;
  /** Gate rejections keyed by reason enum, e.g. { employees_above_max: 7 }. */
  gateRejectionsByReason: Record<string, number>;
  /** True only when the operator deliberately opted into oversized companies. */
  allowLargeCompanies: boolean;
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
): Promise<{
  cursor: DiscoveryCursor;
  resetReason: "page_size_changed" | "consumed_past_pool" | null;
}> {
  const [row] = await db
    .select()
    .from(companyDiscoveryRuns)
    .where(
      sql`${companyDiscoveryRuns.vertical} = ${vertical}
        AND ${companyDiscoveryRuns.market} = ${market}
        AND ${companyDiscoveryRuns.pool} = ${pool}`,
    )
    .limit(1);
  if (!row) return { cursor: { ...EMPTY_CURSOR }, resetReason: null };
  return reconcileCursor(
    {
      perPage: row.perPage,
      consumed: row.consumed,
      totalEntries: row.totalEntries,
      poolExhausted: row.poolExhausted,
    },
    APOLLO_PER_PAGE,
  );
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
  return rows
    // Supplementary sources keep their own cursors in this table under their
    // own `pool` value. They page on a different grid (SerpApi search slots,
    // not Apollo rows), so reporting them as an Apollo pool would put a second,
    // wrong row under the same (vertical, market) in the launcher.
    .filter((row) => row.pool === "sized" || row.pool === "unknown_size")
    .map((row) => ({
    vertical: row.vertical,
    market: row.market,
    pool: row.pool === "unknown_size" ? "unknown_size" : "sized",
    lastRunAt: row.lastRunAt,
    status: poolStatus(
      reconcileCursor(
        {
          perPage: row.perPage,
          consumed: row.consumed,
          totalEntries: row.totalEntries,
          poolExhausted: row.poolExhausted,
        },
        APOLLO_PER_PAGE,
      ).cursor,
    ),
  }));
}

/**
 * Forget the Apollo cursors for one (vertical, market) so the next run starts
 * at page 1. Used when the operator wants to search again after a stale
 * exhaustion, or after keyword / page-size changes the leftover cursor does
 * not describe.
 *
 * Does not touch supplementary-source cursors (SerpApi search slots live in
 * the same table under a different `pool` value).
 */
export async function resetDiscoveryCursors(
  vertical: string,
  market: string,
): Promise<{ reset: number }> {
  const deleted = await db
    .delete(companyDiscoveryRuns)
    .where(
      and(
        eq(companyDiscoveryRuns.vertical, vertical),
        eq(companyDiscoveryRuns.market, market),
        inArray(companyDiscoveryRuns.pool, ["sized", "unknown_size"]),
      ),
    )
    .returning({ pool: companyDiscoveryRuns.pool });
  return { reset: deleted.length };
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

/**
 * Match a discovered company to a row the pipeline already has.
 *
 * This is also what attaches job signals: the review queue reads
 * `job_listings` by `company_id`, so a wrong match here hands one company's
 * open roles, industry and identity to another. Two guards keep the name leg
 * honest — it may not overrule a domain that disagrees, and it may not fire on
 * a key the suffix stripper reduced to one generic word.
 */
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
  if (companyNameKeyStrength(candidate.name) !== "strong") return null;
  const nameKey = normalizeCompanyKey(candidate.name);
  if (!nameKey) return null;
  const byName = index.byName.get(nameKey);
  if (!byName) return null;
  // Two different registered domains mean two different companies, however
  // close the names read.
  const existingDomain = byName.domain?.trim().toLowerCase();
  if (domain && existingDomain && existingDomain !== domain) return null;
  return byName;
}

/**
 * Which industry string to keep. Apollo's fine-grained value ("law practice",
 * "marketing & advertising") beats the coarse rollup the job-scrape worker
 * writes when Apollo gave it nothing — otherwise every discovered company that
 * already existed from the scrape keeps showing a bucket label like
 * "Professional & Business Services" instead of what it actually is.
 */
export function preferredIndustry(
  existing: string | null,
  fromApollo: string | null,
): string | null {
  if (!fromApollo?.trim()) return existing;
  if (!existing?.trim()) return fromApollo;
  return isCoarseSectorRollup(existing) ? fromApollo : existing;
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
        industry: preferredIndustry(existing.industry, candidate.industry),
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
        // Same rule as the update path: a coarse rollup placeholder yields to
        // Apollo's real industry, a real value is never overwritten.
        industry: candidate.industry
          ? sql`CASE
              WHEN ${companies.industry} IS NULL THEN ${candidate.industry}
              WHEN ${companies.industry} IN (${sql.join(
                allSectorFilterOptions().map((label) => sql`${label}`),
                sql`, `,
              )}) THEN ${candidate.industry}
              ELSE ${companies.industry}
            END`
          : sql`${companies.industry}`,
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
  /**
   * The operator's "allow larger companies selectively" escape hatch. Never a
   * default and never automatic — it must be passed per run, and it only
   * relaxes the headcount ceiling, not the staffing/government/enterprise
   * rejections.
   */
  allowLargeCompanies?: boolean;
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
  const allowLargeCompanies = options.allowLargeCompanies === true;
  const context =
    options.context ?? manualEnrichContext(`discovery:${vertical}:${market}`);
  const notes: string[] = [];

  const sizedLoad = await loadCursor(vertical, market, "sized");
  const unknownLoad = await loadCursor(vertical, market, "unknown_size");
  const sizedCursor = sizedLoad.cursor;
  const unknownCursor = unknownLoad.cursor;
  if (sizedLoad.resetReason) {
    notes.push(
      sizedLoad.resetReason === "consumed_past_pool"
        ? "Sized-pool cursor was past its own pool size (leftover from the 25-row page) — restarted from the top."
        : "Sized-pool cursor was exhausted at the old 25-row page size — restarted from the top.",
    );
  }
  if (unknownLoad.resetReason) {
    notes.push(
      "Size-unknown cursor was marked exhausted under the old page size — " +
        "restarted. That pass is where small local firms without an Apollo headcount live.",
    );
  }

  let creditsSpent = 0;
  let sizedResult: Awaited<ReturnType<typeof searchOrganizations>> = {
    organizations: [],
    page: pageForCursor(sizedCursor, APOLLO_PER_PAGE),
    perPage: APOLLO_PER_PAGE,
    totalEntries: sizedCursor.totalEntries,
    totalPages: null,
  };
  let nextSizedCursor = sizedCursor;

  if (sizedCursor.poolExhausted) {
    notes.push(
      "Sized pool already exhausted for this market — skipped so we do not spend a credit on an empty page.",
    );
  } else {
    const sizedPage = pageForCursor(sizedCursor, APOLLO_PER_PAGE);
    sizedResult = await searchOrganizations({
      apiKey,
      locations: [market],
      keywordTags: keywordTagsForVertical(vertical),
      employeeRange: apolloEmployeeRange(vertical),
      page: sizedPage,
      perPage: APOLLO_PER_PAGE,
      context,
      usageLabel: `discovery:${vertical}:${market}:sized`,
    });
    creditsSpent += 1;
    // `requested` is the PAGE size, not the run's limit: a short page is Apollo
    // saying it has nothing left for these filters, and comparing against a
    // smaller limit would read a full page as a short one and declare the pool
    // exhausted on the first run.
    nextSizedCursor = advanceCursor(sizedCursor, {
      requested: APOLLO_PER_PAGE,
      returned: sizedResult.organizations.length,
      totalEntries: sizedResult.totalEntries,
      perPage: APOLLO_PER_PAGE,
    });
  }

  let unknownOrganizations: typeof sizedResult.organizations = [];
  let unknownReturned = 0;
  let nextUnknownCursor = unknownCursor;
  if (includeUnknownSize && !unknownCursor.poolExhausted) {
    const unknownPage = pageForCursor(unknownCursor, APOLLO_PER_PAGE);
    const unknownResult = await searchOrganizations({
      apiKey,
      locations: [market],
      keywordTags: keywordTagsForVertical(vertical),
      employeeRange: null,
      page: unknownPage,
      perPage: APOLLO_PER_PAGE,
      context,
      usageLabel: `discovery:${vertical}:${market}:unknown_size`,
    });
    creditsSpent += 1;
    unknownOrganizations = unknownResult.organizations;
    unknownReturned = unknownResult.organizations.length;
    nextUnknownCursor = advanceCursor(unknownCursor, {
      requested: APOLLO_PER_PAGE,
      returned: unknownReturned,
      totalEntries: unknownResult.totalEntries,
      perPage: APOLLO_PER_PAGE,
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

  /*
   * Supplementary sources (SerpApi Google Maps today) fan out AFTER Apollo and
   * are strictly additive. Everything downstream — dedupe, ICP annotation,
   * scoring, the review queue — is untouched, because a source hands back
   * `DiscoveredOrganization`s and nothing else.
   *
   * A supplementary source can NEVER fail the run. If it is off, capped,
   * erroring or misconfigured, the Apollo results still land and the summary
   * says why the source contributed nothing.
   */
  const sourceReports: DiscoverySourceReport[] = [];
  let supplementaryOrganizations: typeof sizedResult.organizations = [];
  const { sources, skipped: sourcesSkipped } =
    await resolveSupplementarySources(vertical);
  for (const source of sources) {
    try {
      const outcome = await source.discover({
        vertical,
        market,
        limit,
        context,
      });
      supplementaryOrganizations = [
        ...supplementaryOrganizations,
        ...outcome.organizations,
      ];
      notes.push(...outcome.notes);
      sourceReports.push({
        name: source.name,
        billingUnit: source.billingUnit,
        unitsSpent: outcome.unitsSpent,
        returned: outcome.organizations.length,
        rejected: outcome.rejected,
        poolExhausted: outcome.poolExhausted,
      });
    } catch (err) {
      console.error(`Discovery source ${source.name} failed:`, err);
      notes.push(
        `Supplementary source ${source.name} failed and was skipped — ` +
          "the Apollo results below are unaffected.",
      );
      sourcesSkipped.push({
        name: source.name,
        reason: err instanceof Error ? err.message : "source failed",
      });
    }
  }

  /*
   * QUANTIFY. Maps can name a company but never size one, so before anything
   * downstream sees these rows Apollo backfills headcount, industry, LinkedIn,
   * revenue and ticker keyed on the normalised domain — one credit per 100
   * domains via `q_organization_domains_list`, not one credit per company.
   *
   * This runs HERE, ahead of candidate selection and ahead of the exclusion
   * gate, on purpose. The gate does most of its work on structural signals
   * (headcount band, revenue ≥ $1B, a ticker, the industry taxonomy) and Maps
   * supplies none of them, so a gate that ran first would wave through exactly
   * the enterprise branch offices and staffing agencies it exists to stop.
   *
   * It never throws and never blocks: a company Apollo has no row for keeps
   * going, size-unknown, which is the pre-existing behaviour this improves on
   * rather than replaces.
   */
  let quantifyCredits = 0;
  // Kept separate from `sizedResult.organizations` so `returnedSized` and the
  // saved cursor keep reporting what Apollo's sized page actually returned.
  const quantifiedSized: typeof sizedResult.organizations = [];
  if (supplementaryOrganizations.length) {
    const quantified = await quantifyOrganizations({
      apiKey,
      organizations: supplementaryOrganizations,
      vertical,
      market,
      context,
    });
    quantifyCredits = quantified.creditsSpent;
    creditsSpent += quantified.creditsSpent;
    notes.push(...quantified.notes);

    /*
     * Route by what we now know, not by where the row came from.
     *
     * `selectDiscoveryCandidates` drops any row in the unknown-size pool that
     * HAS a headcount — the filter that stops Apollo's unfiltered second pass
     * from re-reviewing companies its first pass already returned. A quantified
     * Maps company would be deleted by it, silently, so a row Apollo just sized
     * joins the sized pool where it belongs.
     */
    for (const org of quantified.organizations) {
      if (org.estimatedEmployees == null) unknownOrganizations.push(org);
      else quantifiedSized.push(org);
    }
  }

  // The gate runs AFTER quantify and BEFORE dedupe/write: the size-filtered
  // pass can still return a staffing agency or a .gov, the unknown-headcount
  // pass is unfiltered by construction, and Maps rows now carry Apollo's
  // structural signals so the gate can actually reject them.
  const sizedGate = gateOrganizations(
    [...sizedResult.organizations, ...quantifiedSized],
    vertical,
    allowLargeCompanies,
  );
  // Only the genuinely headcount-less rows of the unknown pass are gated:
  // candidate selection discards the rest anyway, and counting them as
  // rejections would inflate the number the operator uses to diagnose a short
  // run with companies that were never candidates.
  const unknownGate = gateOrganizations(
    unknownOrganizations.filter((org) => org.estimatedEmployees == null),
    vertical,
    allowLargeCompanies,
  );
  const gateRejections = [...sizedGate.rejected, ...unknownGate.rejected];
  const gateRejectionsByReason = summarizeGateReasons(gateRejections);

  const { candidates, duplicatesSkipped, sizeUnknownCount } =
    selectDiscoveryCandidates({
      vertical,
      // Apollo's own page first (already inside sizedGate.kept in page order),
      // then quantified supplementary rows that survived the gate.
      sized: sizedGate.kept,
      unknownSize: unknownGate.kept,
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

  if (!sizedCursor.poolExhausted) {
    await saveCursor(
      vertical,
      market,
      "sized",
      nextSizedCursor,
      sizedResult.organizations.length,
    );
  }
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
  const rejectionNote = describeGateRejections(gateRejectionsByReason);
  if (rejectionNote) {
    notes.push(
      `${rejectionNote} These never entered the queue, so a short run is the ` +
        "gate working, not Apollo running dry.",
    );
  }
  if (allowLargeCompanies) {
    notes.push(
      "Large companies were allowed for this run — oversized firms are shown " +
        "for review instead of rejected. Staffing, government, and known " +
        "enterprises are still rejected.",
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
      sizeSource: headcountProvenance(candidate),
      created,
      autoExcluded: autoExcludedIds.includes(id),
      jobSignal: summarizeJobSignals(listingsByCompany.get(id) ?? []),
    }),
  );

  const withoutJobs = resultCompanies.filter(
    (c) => c.jobSignal.openPositions === 0,
  ).length;
  if (withoutJobs) {
    notes.push(
      `${withoutJobs} of ${resultCompanies.length} have no job postings on file. ` +
        "Discovery does not filter on hiring — these are full-value prospects, " +
        "not misses.",
    );
  }

  return {
    vertical,
    verticalLabel: verticalConfig.label,
    market,
    limit,
    creditsSpent,
    apolloQuantifyCredits: quantifyCredits,
    sources: sourceReports,
    sourcesSkipped,
    returnedSized: sizedResult.organizations.length,
    returnedUnknownSize: unknownReturned,
    companiesReviewed: resultCompanies.length,
    created: resultCompanies.filter((c) => c.created).length,
    updated: alreadyKnown,
    duplicatesSkipped,
    sizeUnknownCount,
    autoExcluded: autoExcludedIds.length,
    gateRejected: gateRejections.length,
    gateRejectionsByReason,
    allowLargeCompanies,
    withJobSignals: resultCompanies.filter((c) => c.jobSignal.openPositions > 0)
      .length,
    pools,
    poolExhausted: pools.sized.exhausted,
    notes,
    companies: resultCompanies,
  };
}
