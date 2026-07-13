/** Admin-configured filters for daily email backlog section. */
export type EmailReportPreferences = {
  /** Search profile names (e.g. "HR Director") — empty = all */
  jobTitleFilters?: string[];
  /** Broad sector names (industry rollup) — empty = all */
  industryFilters?: string[];
  salaryFilter?: "any" | "has_salary" | "min_salary";
  salaryMinUsd?: number;
  /** Top-N ranked backlog rows after filters (default 25) */
  backlogLeadLimit?: number;
  includeBacklogSection?: boolean;
  /**
   * Hot Listings section in daily email. Default ON.
   * Explicit false disables; null/undefined/true keep it on.
   */
  includeHotListingsSection?: boolean;
  /** Top-N hot listings in email (default from HOT_EMAIL_LIMIT / 15). */
  hotListingsLimit?: number;
};

export const DEFAULT_EMAIL_REPORT_PREFERENCES: EmailReportPreferences = {
  jobTitleFilters: [],
  industryFilters: [],
  salaryFilter: "any",
  salaryMinUsd: 80000,
  backlogLeadLimit: 25,
  /** Off until explicitly enabled in Admin — unfinished filter UX must not ship in email. */
  includeBacklogSection: false,
  includeHotListingsSection: true,
  hotListingsLimit: 15,
};

export function normalizeEmailReportPreferences(
  raw: EmailReportPreferences | null | undefined,
): EmailReportPreferences {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_EMAIL_REPORT_PREFERENCES };
  }
  return {
    jobTitleFilters: raw.jobTitleFilters?.filter(Boolean) ?? [],
    industryFilters: raw.industryFilters?.filter(Boolean) ?? [],
    salaryFilter: raw.salaryFilter ?? "any",
    salaryMinUsd: raw.salaryMinUsd ?? DEFAULT_EMAIL_REPORT_PREFERENCES.salaryMinUsd,
    backlogLeadLimit:
      raw.backlogLeadLimit ?? DEFAULT_EMAIL_REPORT_PREFERENCES.backlogLeadLimit,
    // Explicit true only — null/undefined stays off
    includeBacklogSection: raw.includeBacklogSection === true,
    // Default ON — only explicit false disables
    includeHotListingsSection: raw.includeHotListingsSection !== false,
    hotListingsLimit:
      raw.hotListingsLimit ??
      DEFAULT_EMAIL_REPORT_PREFERENCES.hotListingsLimit,
  };
}
