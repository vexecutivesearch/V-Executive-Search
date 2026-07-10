import type { JobListing } from "@/lib/db/schema";
import type { EmailReportPreferences } from "@/lib/email-report-preferences";

export type LeadFilterState = {
  jobTitle: string;
  industry: string;
  salaryFilter: "any" | "has_salary" | "min_salary";
  salaryMinUsd: number;
};

export const DEFAULT_LEAD_FILTER: LeadFilterState = {
  jobTitle: "",
  industry: "",
  salaryFilter: "any",
  salaryMinUsd: 80000,
};

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

export function companyMatchesSalaryFilter(
  listings: Pick<
    JobListing,
    "salaryMin" | "salaryMax" | "salaryText"
  >[],
  salaryFilter: LeadFilterState["salaryFilter"],
  salaryMinUsd: number,
): boolean {
  if (salaryFilter === "any") return true;
  if (!listings.length) return false;

  if (salaryFilter === "has_salary") {
    return listings.some(listingHasSalary);
  }

  return listings.some((l) => {
    const max = listingSalaryMax(l);
    return max != null && max >= salaryMinUsd;
  });
}

export function companyMatchesLeadFilters(
  company: {
    industry?: string | null;
    jobListings: Pick<
      JobListing,
      "title" | "searchName" | "salaryMin" | "salaryMax" | "salaryText"
    >[];
  },
  filters: LeadFilterState | EmailReportPreferences,
): boolean {
  const jobTitle =
    "jobTitle" in filters
      ? filters.jobTitle
      : filters.jobTitleFilters?.[0] ?? "";
  const industry =
    "industry" in filters
      ? filters.industry
      : filters.industryFilters?.[0] ?? "";
  const salaryFilter = filters.salaryFilter ?? "any";
  const salaryMinUsd =
    "salaryMinUsd" in filters && filters.salaryMinUsd != null
      ? filters.salaryMinUsd
      : 80000;

  if (industry.trim()) {
    const ind = (company.industry ?? "").toLowerCase();
    if (!ind.includes(industry.trim().toLowerCase())) return false;
  }

  const listings = company.jobListings;
  if (!listings.length) return false;

  if ("jobTitleFilters" in filters && filters.jobTitleFilters?.length) {
    const ok = filters.jobTitleFilters.some((t) =>
      listings.some((l) => listingMatchesJobTitle(l, t)),
    );
    if (!ok) return false;
  } else if (jobTitle.trim()) {
    const ok = listings.some((l) => listingMatchesJobTitle(l, jobTitle));
    if (!ok) return false;
  }

  if (
    !companyMatchesSalaryFilter(
      listings,
      salaryFilter as LeadFilterState["salaryFilter"],
      salaryMinUsd,
    )
  ) {
    return false;
  }

  return true;
}

/** Multi-select email prefs — any selected title/industry must match (OR within dimension). */
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
  if (prefs.jobTitleFilters?.length) {
    const titleOk = prefs.jobTitleFilters.some((t) =>
      company.jobListings.some((l) => listingMatchesJobTitle(l, t)),
    );
    if (!titleOk) return false;
  }

  if (prefs.industryFilters?.length) {
    const ind = (company.industry ?? "").toLowerCase();
    const industryOk = prefs.industryFilters.some((f) =>
      ind.includes(f.toLowerCase()),
    );
    if (!industryOk) return false;
  }

  return companyMatchesSalaryFilter(
    company.jobListings,
    prefs.salaryFilter ?? "any",
    prefs.salaryMinUsd ?? 80000,
  );
}
