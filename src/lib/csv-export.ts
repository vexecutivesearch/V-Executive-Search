import type { CompanyCardData } from "@/components/CompanyCard";
import type { Contact } from "@/lib/db/schema";
import {
  resolvePersonalEmail,
  resolveWorkEmail,
} from "@/lib/contact-enrichment-limits";
import {
  contactPhonesForDisplay,
  sortPhonesForDisplay,
} from "@/lib/contact-phones";
import type { ListDateRange } from "@/lib/list-date-range";
import {
  getCallSheetCompanies,
  getScrapedCompaniesForExport,
} from "@/lib/queries";

export type ScrapeCsvRow = {
  company_name: string;
  domain: string;
  domain_confidence: string;
  industry: string;
  lead_score: number;
  icp_status: string;
  first_seen: string;
  enrich_run_date: string;
  reason_to_call: string;
  job_title: string;
  job_board: string;
  job_location: string;
  job_url: string;
  salary: string;
  search_name: string;
  job_posted_at: string;
  job_last_seen: string;
  contact_count: number;
};

export type ContactCsvRow = {
  company_name: string;
  domain: string;
  lead_score: number;
  job_title: string;
  job_location: string;
  reason_to_call: string;
  contact_name: string;
  contact_title: string;
  work_email: string;
  personal_email: string;
  phone_1: string;
  phone_2: string;
  phone_3: string;
  linkedin_url: string;
  source: string;
  enrich_run_date: string;
  location_matched: string;
};

function csvCell(value: string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function rowsToCsv(
  headers: string[],
  rows: Record<string, string | number>[],
): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  return lines.join("\n");
}

function formatSalary(listing: CompanyCardData["jobListings"][number]): string {
  if (listing.salaryText) return listing.salaryText;
  if (listing.salaryMin != null && listing.salaryMax != null) {
    return `$${listing.salaryMin}–$${listing.salaryMax}`;
  }
  if (listing.salaryMin != null) return `$${listing.salaryMin}+`;
  return "";
}

export function companiesToScrapeRows(
  companies: CompanyCardData[],
): ScrapeCsvRow[] {
  const rows: ScrapeCsvRow[] = [];
  for (const company of companies) {
    for (const job of company.jobListings) {
      rows.push({
        company_name: company.name,
        domain: company.domain ?? "",
        domain_confidence: company.domainConfidence,
        industry: company.industry ?? "",
        lead_score: company.leadScore ?? 0,
        icp_status: company.icpStatus ?? "",
        first_seen: company.firstSeen,
        enrich_run_date: company.enrichRunDate ?? "",
        reason_to_call: company.reasonToCall ?? "",
        job_title: job.title,
        job_board: job.board ?? "",
        job_location: job.location ?? "",
        job_url: job.url ?? "",
        salary: formatSalary(job),
        search_name: job.searchName ?? "",
        job_posted_at: job.postedAt?.toISOString?.()?.slice(0, 10) ?? "",
        job_last_seen: job.lastSeenRunDate ?? "",
        contact_count: company.contacts.length,
      });
    }
  }
  return rows.sort(
    (a, b) => b.lead_score - a.lead_score || a.company_name.localeCompare(b.company_name),
  );
}

function contactToRow(
  company: CompanyCardData,
  contact: Contact,
  job: CompanyCardData["jobListings"][number] | undefined,
): ContactCsvRow {
  const phones = sortPhonesForDisplay(contactPhonesForDisplay(contact))
    .filter((p) => p.kind !== "company")
    .map((p) => p.number);

  return {
    company_name: company.name,
    domain: company.domain ?? "",
    lead_score: company.leadScore ?? 0,
    job_title: job?.title ?? "",
    job_location: job?.location ?? "",
    reason_to_call: company.reasonToCall ?? "",
    contact_name: contact.name,
    contact_title: contact.title ?? "",
    work_email: resolveWorkEmail(contact) ?? "",
    personal_email: resolvePersonalEmail(contact) ?? "",
    phone_1: phones[0] ?? "",
    phone_2: phones[1] ?? "",
    phone_3: phones[2] ?? "",
    linkedin_url: contact.linkedinUrl ?? "",
    source: contact.sourceProvider ?? "",
    enrich_run_date: company.enrichRunDate ?? "",
    location_matched: contact.locationMatched ? "yes" : "no",
  };
}

export function companiesToContactRows(
  companies: CompanyCardData[],
): ContactCsvRow[] {
  const rows: ContactCsvRow[] = [];
  for (const company of companies) {
    const job = company.jobListings[0];
    for (const contact of company.contacts) {
      rows.push(contactToRow(company, contact, job));
    }
  }
  return rows.sort(
    (a, b) =>
      b.lead_score - a.lead_score ||
      a.company_name.localeCompare(b.company_name) ||
      a.contact_name.localeCompare(b.contact_name),
  );
}

const SCRAPE_HEADERS: (keyof ScrapeCsvRow)[] = [
  "company_name",
  "domain",
  "domain_confidence",
  "industry",
  "lead_score",
  "icp_status",
  "first_seen",
  "enrich_run_date",
  "reason_to_call",
  "job_title",
  "job_board",
  "job_location",
  "job_url",
  "salary",
  "search_name",
  "job_posted_at",
  "job_last_seen",
  "contact_count",
];

const CONTACT_HEADERS: (keyof ContactCsvRow)[] = [
  "company_name",
  "domain",
  "lead_score",
  "job_title",
  "job_location",
  "reason_to_call",
  "contact_name",
  "contact_title",
  "work_email",
  "personal_email",
  "phone_1",
  "phone_2",
  "phone_3",
  "linkedin_url",
  "source",
  "enrich_run_date",
  "location_matched",
];

export async function buildScrapeCsv(range: ListDateRange): Promise<string> {
  const companies = await getScrapedCompaniesForExport(range);
  return rowsToCsv(SCRAPE_HEADERS, companiesToScrapeRows(companies));
}

export async function buildContactsCsv(range: ListDateRange): Promise<string> {
  const companies = await getCallSheetCompanies(range);
  return rowsToCsv(CONTACT_HEADERS, companiesToContactRows(companies));
}

export function exportFilename(
  kind: "scrape" | "contacts",
  range: ListDateRange,
): string {
  const suffix =
    range.from === range.to ? range.from : `${range.from}_to_${range.to}`;
  return `vexec-${kind}-${suffix}.csv`;
}
