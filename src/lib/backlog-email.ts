import { getBacklogCompanies, getTopRankedLeads } from "@/lib/queries";
import {
  DEFAULT_EMAIL_REPORT_PREFERENCES,
  normalizeEmailReportPreferences,
  type EmailReportPreferences,
} from "@/lib/email-report-preferences";
import { companyMatchesEmailReportFilters } from "@/lib/lead-filters";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { parseJobLocation } from "@/lib/location-match";
import { listingHasSalary, listingSalaryMax } from "@/lib/lead-filters";

export type BacklogEmailLead = {
  rank: number;
  score: number;
  company: string;
  company_id: string;
  industry: string | null;
  job_title: string | null;
  job_location: string | null;
  salary_text: string | null;
  search_name: string | null;
};

function companyToBacklogEmailLead(
  company: Awaited<ReturnType<typeof getBacklogCompanies>>[number],
  rank: number,
): BacklogEmailLead {
  const job = company.jobListings[0];
  const salaryText =
    job?.salaryText ??
    (job && listingHasSalary(job)
      ? listingSalaryMax(job) != null
        ? `$${listingSalaryMax(job)!.toLocaleString()}+`
        : null
      : null);

  return {
    rank,
    score: company.leadScore ?? 0,
    company: company.name,
    company_id: company.id,
    industry: company.industry ?? null,
    job_title: job?.title ?? null,
    job_location:
      (job?.location && parseJobLocation(job.location)?.label) ||
      job?.location ||
      null,
    salary_text: salaryText,
    search_name: job?.searchName ?? null,
  };
}

/** Always-on top job posts for the daily email — enriched or not. */
export async function getTopRankedJobPosts(limit = 5): Promise<BacklogEmailLead[]> {
  const ranked = await getTopRankedLeads(limit);
  return ranked.map((company, index) =>
    companyToBacklogEmailLead(company, index + 1),
  );
}

export async function getFilteredBacklogEmailLeads(
  prefs?: EmailReportPreferences,
): Promise<BacklogEmailLead[]> {
  const settings = await getOrCreateSettings();
  const normalized = normalizeEmailReportPreferences(
    prefs ?? settings.emailReportPreferences ?? DEFAULT_EMAIL_REPORT_PREFERENCES,
  );

  if (!normalized.includeBacklogSection) return [];

  const backlog = await getBacklogCompanies();
  const limit = normalized.backlogLeadLimit ?? 25;

  const filtered = backlog.filter((c) =>
    companyMatchesEmailReportFilters(c, normalized),
  );

  const leads: BacklogEmailLead[] = [];
  let rank = 0;
  for (const company of filtered.slice(0, limit)) {
    const job = company.jobListings[0];
    if (!job) continue;
    rank += 1;
    leads.push(companyToBacklogEmailLead(company, rank));
  }

  return leads;
}
