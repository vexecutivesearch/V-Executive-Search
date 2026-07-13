/**
 * Suggested focus-keyword scrape profiles (additive OR with Market scan buckets).
 * These do NOT replace the broad daily search — they run alongside it across
 * Indeed / LinkedIn / Google (SerpAPI) / other active boards.
 *
 * White-label: Admin shows these as chips; tenants can enable, disable, or add custom.
 */

export type ScrapeKeywordSuggestion = {
  /** Admin / Today filter label */
  name: string;
  /** Board query term (JobSpy / SerpAPI role word) */
  searchTerm: string;
  /** Grouping for Admin UI */
  family:
    | "Legal"
    | "Marketing"
    | "Construction"
    | "HR"
    | "Finance"
    | "Custom";
};

/** Recommended focus keywords for executive recruiting verticals. */
export const SUGGESTED_FOCUS_KEYWORDS: ScrapeKeywordSuggestion[] = [
  { name: "Legal", searchTerm: "legal", family: "Legal" },
  { name: "Paralegal", searchTerm: "paralegal", family: "Legal" },
  { name: "Attorney", searchTerm: "attorney", family: "Legal" },
  { name: "Law firm", searchTerm: "law firm", family: "Legal" },
  { name: "Marketing", searchTerm: "marketing", family: "Marketing" },
  { name: "Construction", searchTerm: "construction", family: "Construction" },
  { name: "HR", searchTerm: "hr", family: "HR" },
  { name: "Human resources", searchTerm: "human resources", family: "HR" },
  { name: "Finance", searchTerm: "finance", family: "Finance" },
  { name: "Accounting", searchTerm: "accounting", family: "Finance" },
];

export function normalizeScrapeSearchTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}
