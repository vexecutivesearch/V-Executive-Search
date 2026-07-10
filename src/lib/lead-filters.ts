import type { JobListing } from "@/lib/db/schema";
import type { EmailReportPreferences } from "@/lib/email-report-preferences";
import {
  isKnownSectorName,
  sectorFromIndustry,
} from "@/lib/industry-sectors";

export type LeadFilterState = {
  jobTitle: string;
  /** Broad sector name (from industry rollup), not raw Apollo industry. */
  industry: string;
  salaryFilter: "any" | "has_salary" | "min_salary";
  salaryMinUsd: number;
  /** When true, rows with null industry still pass an industry filter */
  includeUnknownIndustry: boolean;
  /** When true, rows with no salary still pass min_salary filter */
  includeUnknownSalary: boolean;
};

export const DEFAULT_LEAD_FILTER: LeadFilterState = {
  jobTitle: "",
  industry: "",
  salaryFilter: "any",
  salaryMinUsd: 80000,
  includeUnknownIndustry: true,
  includeUnknownSalary: true,
};

export const DEFAULT_EMAIL_FILTER_BEHAVIOR = {
  includeUnknownIndustry: true,
  includeUnknownSalary: true,
} as const;

export function listingSalaryMax(listing: {
  salaryMax?: number | null;
  salaryMin?: number | null;
}): number | null {
  if (listing.salaryMax != null) return listing.salaryMax;
  if (listing.salaryMin != null) return listing.salaryMin;
  return null;
}

export function listingHasSalary(listing: {
  salaryMax?: number | null;
  salaryMin?: number | null;
  salaryText?: string | null;
}): boolean {
  return (
    listing.salaryMin != null ||
    listing.salaryMax != null ||
    Boolean(listing.salaryText?.trim())
  );
}

export function listingMatchesJobTitle(
  listing: Pick<JobListing, "title" | "searchName">,
  jobTitleFilter: string,
): boolean {
  if (!jobTitleFilter.trim()) return true;
  const needle = jobTitleFilter.trim().toLowerCase();
  const search = (listing.searchName ?? "").toLowerCase();
  const title = (listing.title ?? "").toLowerCase();
  return (
    search.startsWith(needle) ||
    search.includes(needle) ||
    title.includes(needle)
  );
}

export function companyMatchesJobTitleFilters(
  listings: Pick<JobListing, "title" | "searchName">[],
  jobTitleFilters: string[],
): boolean {
  if (!jobTitleFilters.length) return true;
  return jobTitleFilters.some((t) =>
    listings.some((l) => listingMatchesJobTitle(l, t)),
  );
}

/**
 * Match company raw industry against sector filters (or legacy raw substrings).
 * Filters are sector names from the rollup map; raw industry stays on the record.
 */
export function companyMatchesIndustryFilters(
  industry: string | null | undefined,
  industryFilters: string[],
  includeUnknownIndustry: boolean,
): boolean {
  if (!industryFilters.length) return true;
  const raw = (industry ?? "").trim();
  if (!raw) return includeUnknownIndustry;

  const sector = sectorFromIndustry(raw);
  const sectorOk = industryFilters.some((f) => {
    const needle = f.trim();
    if (!needle) return false;
    if (isKnownSectorName(needle)) {
      return sector === needle;
    }
    // Legacy email prefs / free-text: substring on raw industry
    return raw.toLowerCase().includes(needle.toLowerCase());
  });
  return sectorOk;
}

export function companyMatchesSalaryFilter(
  listings: Pick<
    JobListing,
    "salaryMin" | "salaryMax" | "salaryText"
  >[],
  salaryFilter: LeadFilterState["salaryFilter"],
  salaryMinUsd: number,
  includeUnknownSalary = true,
): boolean {
  if (salaryFilter === "any") return true;
  if (!listings.length) return false;

  if (salaryFilter === "has_salary") {
    return listings.some(listingHasSalary);
  }

  const hasNumericMatch = listings.some((l) => {
    const max = listingSalaryMax(l);
    return max != null && max >= salaryMinUsd;
  });
  if (hasNumericMatch) return true;

  if (includeUnknownSalary) {
    return listings.some(
      (l) => listingSalaryMax(l) == null && !listingHasSalary(l),
    );
  }

  return false;
}

export function companyMatchesLeadFilters(
  company: {
    industry?: string | null;
    jobListings: Pick<
      JobListing,
      "title" | "searchName" | "salaryMin" | "salaryMax" | "salaryText"
    >[];
  },
  filters: LeadFilterState,
): boolean {
  const listings = company.jobListings;
  if (!listings.length) return false;

  if (
    !companyMatchesIndustryFilters(
      company.industry,
      filters.industry.trim() ? [filters.industry.trim()] : [],
      filters.includeUnknownIndustry !== false,
    )
  ) {
    return false;
  }

  if (
    filters.jobTitle.trim() &&
    !companyMatchesJobTitleFilters(listings, [filters.jobTitle.trim()])
  ) {
    return false;
  }

  return companyMatchesSalaryFilter(
    listings,
    filters.salaryFilter,
    filters.salaryMinUsd,
    filters.includeUnknownSalary !== false,
  );
}

/** Email backlog prefs — same semantics as Today filters (include unknown by default). */
export function companyMatchesEmailReportFilters(
  company: {
    industry?: string | null;
    jobListings: Pick<
      JobListing,
      "title" | "searchName" | "salaryMin" | "salaryMax" | "salaryText"
    >[];
  },
  prefs: EmailReportPreferences,
): boolean {
  const listings = company.jobListings;
  if (!listings.length) return false;

  if (
    !companyMatchesJobTitleFilters(listings, prefs.jobTitleFilters ?? [])
  ) {
    return false;
  }

  if (
    !companyMatchesIndustryFilters(
      company.industry,
      prefs.industryFilters ?? [],
      DEFAULT_EMAIL_FILTER_BEHAVIOR.includeUnknownIndustry,
    )
  ) {
    return false;
  }

  return companyMatchesSalaryFilter(
    listings,
    prefs.salaryFilter ?? "any",
    prefs.salaryMinUsd ?? 80000,
    DEFAULT_EMAIL_FILTER_BEHAVIOR.includeUnknownSalary,
  );
}
