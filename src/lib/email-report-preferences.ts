/** Admin-configured filters for daily email backlog section. */
export type EmailReportPreferences = {
  /** Search profile names (e.g. "HR Director") — empty = all */
  jobTitleFilters?: string[];
  /** Company industry strings — empty = all */
  industryFilters?: string[];
  salaryFilter?: "any" | "has_salary" | "min_salary";
  salaryMinUsd?: number;
  /** Top-N ranked backlog rows after filters (default 25) */
  backlogLeadLimit?: number;
  includeBacklogSection?: boolean;
};

export const DEFAULT_EMAIL_REPORT_PREFERENCES: EmailReportPreferences = {
  jobTitleFilters: [],
  industryFilters: [],
  salaryFilter: "any",
  salaryMinUsd: 80000,
  backlogLeadLimit: 25,
  includeBacklogSection: true,
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
    includeBacklogSection:
      raw.includeBacklogSection ??
      DEFAULT_EMAIL_REPORT_PREFERENCES.includeBacklogSection,
  };
}
