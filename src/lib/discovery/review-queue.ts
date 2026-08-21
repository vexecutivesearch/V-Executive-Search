/**
 * Review queue reads for company-first discovery.
 *
 * Everything the operator needs to make a keep/kill call on one screen:
 * company, website, industry, city/state, size (or "size unknown"), main
 * phone, company LinkedIn, vertical, and job/hiring signals with an open
 * position count. No paid call happens on this path.
 */

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callListEntries,
  companies,
  companyIcp,
  contacts,
  jobListings,
  type CompanyReviewStatus,
} from "@/lib/db/schema";
import { isCoarseSectorRollup } from "@/lib/industry-sectors";
import { parseJobLocation } from "@/lib/location-match";
// The queue's filter vocabulary is defined once, next to ReviewScope, so the
// list and the per-bucket counts cannot drift apart.
import type { HiringFilter } from "@/lib/crm-location-scope";
import { companyStatusForReviewStatus } from "./review-actions";
import { getVerticalConfig } from "./verticals";
import {
  verticalEvidence,
  type VerticalEvidence,
} from "./vertical-evidence";
import { summarizeJobSignals, type JobSignalSummary } from "./job-signals";

export const REVIEW_QUEUE_PAGE_SIZE = 100;

export type ReviewQueueContact = {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  emailDeliverable: boolean | null;
  revealStatus: string | null;
};

export type ReviewQueueRow = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  stateAbbr: string | null;
  estimatedEmployees: number | null;
  sizeUnknown: boolean;
  phone: string | null;
  linkedinUrl: string | null;
  vertical: string | null;
  verticalLabel: string | null;
  /** Whether the company's own data backs the search vertical. */
  verticalEvidence: VerticalEvidence;
  /**
   * True when `industry` is a coarse pipeline rollup label rather than an
   * Apollo industry — the UI must not present it as Apollo's answer.
   */
  industryIsRollup: boolean;
  reviewStatus: CompanyReviewStatus;
  leadScore: number;
  icpAdjustedScore: number | null;
  icpFlags: string[];
  icpStatus: string;
  market: string | null;
  jobSignal: JobSignalSummary;
  contactCount: number;
  revealedContactCount: number;
  primaryContact: ReviewQueueContact | null;
  /** Already on the Call List — the row shows a link instead of an add button. */
  onCallList: boolean;
  firstSeen: string;
};

/**
 * The queue's scope predicates, with no review bucket.
 *
 * Deliberately no state/city: browse geography reads job-listing locations,
 * and a company-first Apollo row often has no listings at all, so any state
 * selection silently emptied the queue. The market a row was FOUND IN
 * (companies.source_market) is its only geography here.
 */
export type ReviewQueueScopeFilters = {
  vertical?: string;
  market?: string;
  search?: string;
  hiring?: HiringFilter;
};

export type ReviewQueueFilters = ReviewQueueScopeFilters & {
  reviewStatus?: CompanyReviewStatus | "all";
  page?: number;
};

export type ReviewQueueResult = {
  rows: ReviewQueueRow[];
  totalMatched: number;
  page: number;
  pageCount: number;
};

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Apollo stores full state names; the Pipeline rail filters on abbreviations. */
export function stateAbbrFor(
  city: string | null,
  state: string | null,
): string | null {
  if (!state) return null;
  const parsed =
    parseJobLocation(city ? `${city}, ${state}` : state) ??
    parseJobLocation(state);
  return parsed?.stateAbbr ?? (state.length === 2 ? state.toUpperCase() : null);
}

/**
 * The single definition of what the Discovery review queue is scoped to.
 *
 * Both the list (getReviewQueue) and the per-bucket chip counts
 * (getReviewBucketCounts) are built from this, so a count can never promise
 * rows the list then filters away — the bug that had the tab reading
 * "Discovery review (47)" over an empty list. The bucket predicate is applied
 * separately because the counts group by it.
 */
export function reviewQueueConditions(filters: ReviewQueueScopeFilters): SQL[] {
  // review_status is null for every company that never went through the
  // review queue, which is exactly the pre-discovery pipeline.
  const conditions: SQL[] = [sql`${companies.reviewStatus} IS NOT NULL`];

  if (filters.vertical) {
    conditions.push(sql`${companies.vertical} = ${filters.vertical}`);
  }
  if (filters.market) {
    conditions.push(sql`${companies.sourceMarket} = ${filters.market}`);
  }
  const hiring = filters.hiring ?? "any";
  if (hiring !== "any") {
    const openListing = sql`EXISTS (
      SELECT 1 FROM job_listings AS jl
      WHERE jl.company_id = ${companies.id} AND jl.archived_at IS NULL
    )`;
    conditions.push(hiring === "hiring" ? openListing : sql`NOT ${openListing}`);
  }
  const term = filters.search?.trim();
  if (term) {
    const pattern = `%${escapeLike(term)}%`;
    conditions.push(sql`(
      ${companies.name} ILIKE ${pattern}
      OR ${companies.domain} ILIKE ${pattern}
      OR ${companies.industry} ILIKE ${pattern}
    )`);
  }

  return conditions;
}

function buildConditions(filters: ReviewQueueFilters): SQL[] {
  const conditions = reviewQueueConditions(filters);
  const status = filters.reviewStatus ?? "pending";
  if (status !== "all") {
    conditions.push(sql`${companies.reviewStatus} = ${status}`);
  }
  return conditions;
}

export async function getReviewQueue(
  filters: ReviewQueueFilters = {},
): Promise<ReviewQueueResult> {
  const page = Math.max(1, filters.page ?? 1);
  const conditions = buildConditions(filters);
  const where = and(...conditions.map((c) => sql`(${c})`));

  const [{ count: totalMatched }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(companies)
    .where(where);

  const rows = await db
    .select({ company: companies, icp: companyIcp })
    .from(companies)
    .leftJoin(companyIcp, eq(companyIcp.companyId, companies.id))
    .where(where)
    .orderBy(desc(companies.leadScore), desc(companies.updatedAt))
    .limit(REVIEW_QUEUE_PAGE_SIZE)
    .offset((page - 1) * REVIEW_QUEUE_PAGE_SIZE);

  const ids = rows.map((r) => r.company.id);
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

  const onCallList = new Set(
    ids.length
      ? (
          await db
            .select({ companyId: callListEntries.companyId })
            .from(callListEntries)
            .where(inArray(callListEntries.companyId, ids))
        ).map((r) => r.companyId)
      : [],
  );

  const contactRows = ids.length
    ? await db
        .select()
        .from(contacts)
        .where(inArray(contacts.companyId, ids))
    : [];
  const contactsByCompany = new Map<string, typeof contactRows>();
  for (const row of contactRows) {
    const list = contactsByCompany.get(row.companyId) ?? [];
    list.push(row);
    contactsByCompany.set(row.companyId, list);
  }

  const mapped: ReviewQueueRow[] = rows.map(({ company, icp }) => {
    const companyContacts = contactsByCompany.get(company.id) ?? [];
    const revealed = companyContacts.filter(
      (c) => c.revealStatus === "revealed" || c.email || c.workEmail,
    );
    const primary =
      revealed.find((c) => c.isPrimary) ?? revealed[0] ?? null;
    return {
      id: company.id,
      name: company.name,
      domain: company.domain,
      website: company.domain ? `https://${company.domain}` : null,
      industry: company.industry,
      city: company.city,
      state: company.state,
      stateAbbr: stateAbbrFor(company.city, company.state),
      estimatedEmployees: company.estimatedEmployees,
      sizeUnknown: company.estimatedEmployees == null,
      phone: company.phone,
      linkedinUrl: company.linkedinUrl,
      vertical: company.vertical,
      verticalLabel: getVerticalConfig(company.vertical)?.label ?? null,
      verticalEvidence: verticalEvidence({
        vertical: company.vertical,
        name: company.name,
        industry: company.industry,
      }),
      industryIsRollup: isCoarseSectorRollup(company.industry),
      reviewStatus: (company.reviewStatus ?? "pending") as CompanyReviewStatus,
      leadScore: company.leadScore ?? 0,
      icpAdjustedScore: icp?.icpAdjustedScore ?? null,
      icpFlags: icp?.exclusionFlags ?? [],
      icpStatus: company.icpStatus,
      market: company.sourceMarket,
      firstSeen: company.firstSeen,
      jobSignal: summarizeJobSignals(listingsByCompany.get(company.id) ?? []),
      contactCount: companyContacts.length,
      revealedContactCount: revealed.length,
      onCallList: onCallList.has(company.id),
      primaryContact: primary
        ? {
            id: primary.id,
            name: primary.name,
            title: primary.title,
            email: primary.workEmail ?? primary.email ?? primary.personalEmail,
            phone: primary.personalPhone ?? primary.phone,
            linkedinUrl: primary.linkedinUrl,
            emailDeliverable: primary.emailDeliverable,
            revealStatus: primary.revealStatus,
          }
        : null,
    };
  });

  return {
    rows: mapped,
    totalMatched,
    page,
    pageCount: Math.max(1, Math.ceil(totalMatched / REVIEW_QUEUE_PAGE_SIZE)),
  };
}

/** Verticals/markets already present in the queue (filter options). */
export async function getReviewQueueFacets(): Promise<{
  verticals: string[];
  markets: string[];
}> {
  const rows = await db
    .selectDistinct({
      vertical: companies.vertical,
      market: companies.sourceMarket,
    })
    .from(companies)
    .where(sql`${companies.reviewStatus} IS NOT NULL`);

  const verticals = new Set<string>();
  const markets = new Set<string>();
  for (const row of rows) {
    if (row.vertical) verticals.add(row.vertical);
    if (row.market) markets.add(row.market);
  }
  return {
    verticals: [...verticals].sort(),
    markets: [...markets].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Review action. Never touches `companies.status`: outreach enrollment gates on
 * status = 'new', so a review decision must not move a company out of it.
 * The exceptions are the two decisions that ARE pipeline decisions —
 * do-not-contact and existing-client both mean "stop", which is what
 * status 'skipped' / 'client' already mean to the rest of the system.
 */
export async function setCompanyReviewStatus(
  companyId: string,
  status: CompanyReviewStatus,
): Promise<void> {
  const pipelineStatus = companyStatusForReviewStatus(status);
  const statusUpdate = pipelineStatus ? { status: pipelineStatus } : {};

  await db
    .update(companies)
    .set({
      reviewStatus: status,
      reviewStatusUpdatedAt: new Date(),
      ...statusUpdate,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));
}
