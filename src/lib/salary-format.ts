import type { JobListing } from "@/lib/db/schema";

/** Human salary label from a listing — text as-is, else numeric range. */
export function formatListingSalary(
  listing: Pick<JobListing, "salaryMin" | "salaryMax" | "salaryText">,
): string | null {
  if (listing.salaryText?.trim()) return listing.salaryText.trim();
  if (listing.salaryMin != null && listing.salaryMax != null) {
    return `$${listing.salaryMin.toLocaleString()}–$${listing.salaryMax.toLocaleString()}`;
  }
  if (listing.salaryMin != null) return `$${listing.salaryMin.toLocaleString()}+`;
  if (listing.salaryMax != null) return `up to $${listing.salaryMax.toLocaleString()}`;
  return null;
}

/** Listing with salary info preferred, else the first (most recent) listing. */
export function pickDisplayListing<
  T extends Pick<JobListing, "salaryMin" | "salaryMax" | "salaryText">,
>(listings: T[]): T | undefined {
  return listings.find((l) => formatListingSalary(l) !== null) ?? listings[0];
}
