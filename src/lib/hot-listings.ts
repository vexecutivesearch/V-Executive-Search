/**
 * Shared Hot Listings filter + one-line format.
 * Used by /today Hot Listings tab and the daily email — one source of truth.
 */

import type { CompanyCardData } from "@/components/CompanyCard";
import type { JobListing } from "@/lib/db/schema";
import {
  HOT_EXCLUDE_STAFFING,
  HOT_EXCLUDED_SECTORS,
  hotEmailLimit,
  hotMaxEmployees,
  hotMinEmployees,
} from "@/lib/hot-listings-config";
import { isStaffingAgency } from "@/lib/icp-filter";
import {
  listingHasSalary,
  listingSalaryMax,
} from "@/lib/lead-filters";
import { parseJobLocation } from "@/lib/location-match";
import { isNewToday } from "@/lib/new-today";
import {
  classifyRoleFamily,
  ROLE_FAMILIES,
  type RoleFamily,
} from "@/lib/role-families";
import { sectorFromIndustry } from "@/lib/industry-sectors";

export type HotListingSort = "score" | "salary" | "recent";

export type HotListingFilterState = {
  /** Empty = all five families */
  roleFamilies: RoleFamily[];
  salaryFilter: "any" | "min_salary";
  salaryMinUsd: number;
  /** When min_salary is set, still include rows with no salary (default true). */
  includeUnknownSalary: boolean;
  newTodayOnly: boolean;
};

export const DEFAULT_HOT_LISTING_FILTER: HotListingFilterState = {
  roleFamilies: [...ROLE_FAMILIES],
  salaryFilter: "any",
  salaryMinUsd: 0,
  includeUnknownSalary: true,
  newTodayOnly: false,
};

export type HotListing = {
  companyId: string;
  companyName: string;
  domain: string | null;
  industry: string | null;
  estimatedEmployees: number | null;
  leadScore: number;
  contactCount: number;
  listing: JobListing;
  roleFamily: RoleFamily;
  locationLabel: string;
  salaryAnnual: number | null;
  salaryDisplay: string | null;
  headline: string;
  isNewToday: boolean;
  board: string | null;
};

export type HotListingsHiddenCounts = {
  /** Matched role + geo-ish candidate but company size unknown. */
  sizeUnknown: number;
  /** Matched role + size but failed optional min-salary gate. */
  belowSalary: number;
};

export type HotListingsResult = {
  listings: HotListing[];
  hidden: HotListingsHiddenCounts;
};

/** Annual salary for display / sort — prefers max, then min; null when unknown. */
export function listingAnnualSalary(
  listing: Pick<JobListing, "salaryMin" | "salaryMax" | "salaryText">,
): number | null {
  if (listing.salaryMax != null && listing.salaryMax > 0) {
    return listing.salaryMax;
  }
  if (listing.salaryMin != null && listing.salaryMin > 0) {
    return listing.salaryMin;
  }
  const text = listing.salaryText?.replace(/,/g, "") ?? "";
  const match = text.match(/\$?\s*(\d{2,3}(?:,?\d{3})+|\d{4,7})/);
  if (match) {
    const n = Number.parseInt(match[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n >= 1000) return n;
  }
  return listingSalaryMax(listing);
}

export function formatSalaryAYear(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")} a year`;
}

/**
 * "{Company} is hiring a {Role} in {City}, {State}[ at $X a year]."
 * Salary omitted gracefully when absent (no dangling "at").
 */
export function formatHotListingHeadline(opts: {
  companyName: string;
  role: string;
  locationLabel: string;
  salaryAnnual: number | null;
}): string {
  const company = opts.companyName.trim() || "Company";
  const role = opts.role.trim() || "role";
  const loc = opts.locationLabel.trim();
  const locPart = loc ? ` in ${loc}` : "";
  const salaryPart =
    opts.salaryAnnual != null && opts.salaryAnnual > 0
      ? ` at ${formatSalaryAYear(opts.salaryAnnual)}`
      : "";
  return `${company} is hiring a ${role}${locPart}${salaryPart}.`;
}

export function companyExcludedFromHotListings(opts: {
  companyName: string;
  industry: string | null | undefined;
}): boolean {
  if (HOT_EXCLUDE_STAFFING && isStaffingAgency(opts.companyName)) {
    return true;
  }
  const sector = sectorFromIndustry(opts.industry);
  if (sector && (HOT_EXCLUDED_SECTORS as readonly string[]).includes(sector)) {
    return true;
  }
  // Staffing competitors often land in Professional & Business Services
  if (HOT_EXCLUDE_STAFFING) {
    const raw = (opts.industry ?? "").trim().toLowerCase();
    if (
      raw.includes("staffing") ||
      raw.includes("recruiting") ||
      raw === "human resources"
    ) {
      // Only treat "human resources" industry as staffing-competitor when
      // the company name also looks agency-like; otherwise real employer HR shops stay.
      if (raw.includes("staffing") || raw.includes("recruiting")) return true;
    }
  }
  return false;
}

export function companySizeInHotBand(
  estimatedEmployees: number | null | undefined,
  min = hotMinEmployees(),
  max = hotMaxEmployees(),
): "in_band" | "unknown" | "out_of_band" {
  if (estimatedEmployees == null || estimatedEmployees <= 0) return "unknown";
  if (estimatedEmployees < min || estimatedEmployees > max) return "out_of_band";
  return "in_band";
}

function locationLabelForListing(listing: JobListing): string {
  const parsed = parseJobLocation(listing.location ?? "");
  if (parsed?.label) return parsed.label;
  return (listing.location ?? "").trim();
}

export type HotListingCompanyInput = Pick<
  CompanyCardData,
  "id" | "name" | "domain" | "industry" | "leadScore" | "contacts" | "jobListings" | "firstSeen"
> & {
  estimatedEmployees?: number | null;
};

/**
 * Build Hot Listings from company cards (already geo-filtered listings preferred).
 * Listing-level — one row per qualifying job opening, not deduped companies.
 */
export function buildHotListings(
  companies: HotListingCompanyInput[],
  opts?: {
    filter?: Partial<HotListingFilterState>;
    sort?: HotListingSort;
    listDate?: string;
    minEmployees?: number;
    maxEmployees?: number;
  },
): HotListingsResult {
  const filter: HotListingFilterState = {
    ...DEFAULT_HOT_LISTING_FILTER,
    ...opts?.filter,
    roleFamilies:
      opts?.filter?.roleFamilies?.length
        ? opts.filter.roleFamilies
        : [...ROLE_FAMILIES],
  };
  const sort = opts?.sort ?? "score";
  const minEmp = opts?.minEmployees ?? hotMinEmployees();
  const maxEmp = opts?.maxEmployees ?? hotMaxEmployees();

  const hidden: HotListingsHiddenCounts = {
    sizeUnknown: 0,
    belowSalary: 0,
  };

  const rows: HotListing[] = [];

  for (const company of companies) {
    if (
      companyExcludedFromHotListings({
        companyName: company.name,
        industry: company.industry,
      })
    ) {
      continue;
    }

    const sizeStatus = companySizeInHotBand(
      company.estimatedEmployees,
      minEmp,
      maxEmp,
    );

    for (const listing of company.jobListings) {
      const roleFamily = classifyRoleFamily(listing.title);
      if (!roleFamily) continue;
      if (!filter.roleFamilies.includes(roleFamily)) continue;

      // Size is a hard criterion — unknown tracked, out-of-band dropped silently
      // (out-of-band is intentional product filter, not missing-data).
      if (sizeStatus === "unknown") {
        hidden.sizeUnknown += 1;
        continue;
      }
      if (sizeStatus === "out_of_band") continue;

      const salaryAnnual = listingAnnualSalary(listing);
      if (filter.salaryFilter === "min_salary" && filter.salaryMinUsd > 0) {
        if (salaryAnnual == null) {
          if (!filter.includeUnknownSalary) {
            hidden.belowSalary += 1;
            continue;
          }
        } else if (salaryAnnual < filter.salaryMinUsd) {
          hidden.belowSalary += 1;
          continue;
        }
      }

      const loc = locationLabelForListing(listing);
      const newToday = isNewToday({
        companyFirstSeen: company.firstSeen,
        listings: [listing],
        listDate: opts?.listDate,
      });
      if (filter.newTodayOnly && !newToday) continue;

      rows.push({
        companyId: company.id,
        companyName: company.name,
        domain: company.domain,
        industry: company.industry ?? null,
        estimatedEmployees: company.estimatedEmployees ?? null,
        leadScore: company.leadScore ?? 0,
        contactCount: company.contacts.length,
        listing,
        roleFamily,
        locationLabel: loc,
        salaryAnnual,
        salaryDisplay:
          salaryAnnual != null ? formatSalaryAYear(salaryAnnual) : null,
        headline: formatHotListingHeadline({
          companyName: company.name,
          role: listing.title,
          locationLabel: loc,
          salaryAnnual,
        }),
        isNewToday: newToday,
        board: listing.board ?? null,
      });
    }
  }

  rows.sort((a, b) => {
    if (sort === "salary") {
      const sa = a.salaryAnnual;
      const sb = b.salaryAnnual;
      if (sa == null && sb == null) {
        return b.leadScore - a.leadScore || a.companyName.localeCompare(b.companyName);
      }
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sb - sa || b.leadScore - a.leadScore;
    }
    if (sort === "recent") {
      const ta = a.listing.firstSeenAt
        ? new Date(a.listing.firstSeenAt).getTime()
        : 0;
      const tb = b.listing.firstSeenAt
        ? new Date(b.listing.firstSeenAt).getTime()
        : 0;
      return tb - ta || b.leadScore - a.leadScore;
    }
    return (
      b.leadScore - a.leadScore ||
      a.companyName.localeCompare(b.companyName) ||
      a.listing.title.localeCompare(b.listing.title)
    );
  });

  return { listings: rows, hidden };
}

/** Email DTO — readable one-liner + ranking metadata. */
export type HotListingEmailItem = {
  rank: number;
  score: number;
  company: string;
  company_id: string;
  role_family: RoleFamily;
  job_title: string;
  job_location: string;
  salary_text: string | null;
  headline: string;
  board: string | null;
};

export function hotListingsToEmailItems(
  result: HotListingsResult,
  limit = hotEmailLimit(),
): HotListingEmailItem[] {
  return result.listings.slice(0, limit).map((row, i) => ({
    rank: i + 1,
    score: row.leadScore,
    company: row.companyName,
    company_id: row.companyId,
    role_family: row.roleFamily,
    job_title: row.listing.title,
    job_location: row.locationLabel,
    salary_text: row.salaryDisplay,
    headline: row.headline,
    board: row.board,
  }));
}

/** Re-export for consumers that only need has-salary helpers. */
export { listingHasSalary };
