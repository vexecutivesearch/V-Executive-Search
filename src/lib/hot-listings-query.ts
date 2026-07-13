/**
 * Load companies for Hot Listings for a date range, then apply shared filter.
 * Reuses scrape/backlog company pools — does not change scrape scope.
 */

import type { CompanyCardData } from "@/components/CompanyCard";
import {
  buildHotListings,
  hotListingsToEmailItems,
  type HotListingEmailItem,
  type HotListingFilterState,
  type HotListingsResult,
  type HotListingSort,
} from "@/lib/hot-listings";
import { hotEmailLimit } from "@/lib/hot-listings-config";
import { resolveListDateRange } from "@/lib/list-date-range";
import type { ListDateRange } from "@/lib/list-date-range";
import {
  getBacklogForDateRange,
  getCallSheetCompanies,
  getScrapedCompaniesForExport,
} from "@/lib/queries";
import { businessListDate } from "@/lib/timezone";

function mergeCompaniesById(groups: CompanyCardData[][]): CompanyCardData[] {
  const map = new Map<string, CompanyCardData>();
  for (const group of groups) {
    for (const company of group) {
      const existing = map.get(company.id);
      if (!existing) {
        map.set(company.id, company);
        continue;
      }
      const jobIds = new Set(existing.jobListings.map((j) => j.id));
      const mergedJobs = [
        ...existing.jobListings,
        ...company.jobListings.filter((j) => !jobIds.has(j.id)),
      ];
      map.set(company.id, {
        ...existing,
        estimatedEmployees:
          existing.estimatedEmployees ?? company.estimatedEmployees,
        contacts:
          company.contacts.length > existing.contacts.length
            ? company.contacts
            : existing.contacts,
        jobListings: mergedJobs,
        leadScore: Math.max(existing.leadScore ?? 0, company.leadScore ?? 0),
      });
    }
  }
  return [...map.values()];
}

/** Companies with in-focus jobs in the list window (call sheet + backlog + scrape). */
export async function getHotListingCompanies(
  range: ListDateRange,
): Promise<CompanyCardData[]> {
  const [callSheet, backlog, scraped] = await Promise.all([
    getCallSheetCompanies(range),
    getBacklogForDateRange(range),
    getScrapedCompaniesForExport(range),
  ]);
  return mergeCompaniesById([callSheet, backlog, scraped]);
}

export async function getHotListingsForRange(
  range: ListDateRange,
  opts?: {
    filter?: Partial<HotListingFilterState>;
    sort?: HotListingSort;
  },
): Promise<HotListingsResult> {
  const companies = await getHotListingCompanies(range);
  return buildHotListings(companies, {
    filter: opts?.filter,
    sort: opts?.sort,
    listDate: range.snapshotDate,
  });
}

/** Daily email payload — same filter as the tab, top-N ranked by score. */
export async function getHotListingsForEmail(opts?: {
  limit?: number;
  include?: boolean;
}): Promise<{
  items: HotListingEmailItem[];
  total: number;
  included: boolean;
}> {
  if (opts?.include === false) {
    return { items: [], total: 0, included: false };
  }

  const today = businessListDate();
  const range = resolveListDateRange({ date: today });
  const result = await getHotListingsForRange(range, { sort: "score" });
  const limit = opts?.limit ?? hotEmailLimit();
  return {
    items: hotListingsToEmailItems(result, limit),
    total: result.listings.length,
    included: true,
  };
}
