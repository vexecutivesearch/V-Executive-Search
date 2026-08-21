/**
 * Call List CSV row construction — pure, so the column contract the operator
 * asked for is unit-testable without a database.
 *
 * The one rule worth stating out loud: `open_positions` is blank when we have
 * no job data for the company and "0" only when we scraped it and every
 * listing is closed. "No job data" and "zero open jobs" are different facts,
 * and a company with neither is still a perfectly valid target — a job posting
 * is a signal, never a prerequisite for being on this list.
 */

import type { CompanyCardData } from "@/components/CompanyCard";
import type { CallListEntry } from "@/lib/db/schema";
import { CALL_STATUS_LABELS } from "@/lib/call-status";
import {
  resolvePersonalEmail,
  resolveWorkEmail,
} from "@/lib/contact-enrichment-limits";
import {
  contactPhonesForDisplay,
  sortPhonesForDisplay,
} from "@/lib/contact-phones";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";
import { summarizeJobSignals } from "@/lib/discovery/job-signals";
import { getVerticalConfig } from "@/lib/discovery/verticals";
import { parseJobLocation } from "@/lib/location-match";
import { formatListingSalary, pickDisplayListing } from "@/lib/salary-format";
import { businessListDate } from "@/lib/timezone";

/** Header order = column order in the download. */
export const CALL_LIST_HEADERS = [
  "company_name",
  "industry",
  "vertical",
  "city",
  "state",
  "market",
  "company_size",
  "open_positions",
  "open_position",
  "hiring_signals",
  "salary",
  "contact_name",
  "contact_title",
  "verified_email",
  "email_verified",
  "direct_phone",
  "main_company_phone",
  "company_linkedin",
  "linkedin_profile",
  "opportunity_score",
  "outreach_angle",
  "call_status",
  "last_contact_date",
  "attempts",
  "next_follow_up_date",
  "notes",
  "assigned_team_member",
  "final_result",
  "added_at",
] as const;

export type CallListCsvRow = Record<
  (typeof CALL_LIST_HEADERS)[number],
  string | number
>;

/** Minimum an item needs to produce a row; `CallListItem` satisfies it. */
export type CallListCsvInput = {
  entry: Pick<
    CallListEntry,
    | "primaryContactId"
    | "callStatus"
    | "outreachAngle"
    | "attempts"
    | "lastContactAt"
    | "nextFollowUpDate"
    | "notes"
    | "assignedTo"
    | "finalResult"
    | "addedAt"
  >;
  company: CompanyCardData;
  marketLabel: string | null;
};

export function isoDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function buildCallListCsvRow({
  entry,
  company,
  marketLabel,
}: CallListCsvInput): CallListCsvRow {
  const primaryContact =
    company.contacts.find((c) => c.id === entry.primaryContactId) ??
    [...company.contacts].sort(compareContactsForOutreach)[0];
  const job = company.jobListings[0];
  const salaryJob = pickDisplayListing(company.jobListings);
  const parsedLocation = job?.location ? parseJobLocation(job.location) : null;
  const phones = primaryContact
    ? sortPhonesForDisplay(contactPhonesForDisplay(primaryContact))
    : [];
  const directPhone = phones.find((p) => p.kind !== "company")?.number ?? "";
  const companyPhone =
    phones.find((p) => p.kind === "company")?.number ??
    primaryContact?.companyPhone ??
    company.phone ??
    "";
  const jobSignal = summarizeJobSignals(company.jobListings);

  return {
    company_name: company.name,
    industry: company.industry ?? "",
    vertical:
      getVerticalConfig(company.vertical)?.label ?? company.vertical ?? "",
    // Discovered companies have an Apollo HQ; scraped ones only have a job location.
    city: parsedLocation?.city ?? company.city ?? "",
    state:
      parsedLocation?.stateAbbr ??
      parsedLocation?.stateName ??
      company.state ??
      "",
    market: marketLabel ?? "",
    company_size:
      company.estimatedEmployees == null
        ? "size unknown"
        : String(company.estimatedEmployees),
    open_positions: jobSignal.hasJobData ? jobSignal.openPositions : "",
    open_position: job?.title ?? "",
    hiring_signals: jobSignal.label ?? "",
    salary: salaryJob ? (formatListingSalary(salaryJob) ?? "") : "",
    contact_name: primaryContact?.name ?? "",
    contact_title: primaryContact?.title ?? "",
    verified_email: primaryContact
      ? (resolveWorkEmail(primaryContact) ??
        resolvePersonalEmail(primaryContact) ??
        "")
      : "",
    // Blank when never checked — "unverified" and "not yet verified" differ.
    email_verified:
      primaryContact?.emailDeliverable == null
        ? ""
        : primaryContact.emailDeliverable
          ? "yes"
          : "no",
    direct_phone: directPhone,
    main_company_phone: companyPhone,
    company_linkedin: company.linkedinUrl ?? "",
    linkedin_profile: primaryContact?.linkedinUrl ?? "",
    opportunity_score: company.leadScore ?? 0,
    outreach_angle: entry.outreachAngle ?? company.reasonToCall ?? "",
    call_status: CALL_STATUS_LABELS[entry.callStatus],
    last_contact_date: isoDate(entry.lastContactAt),
    attempts: entry.attempts,
    next_follow_up_date: entry.nextFollowUpDate ?? "",
    notes: entry.notes ?? "",
    assigned_team_member: entry.assignedTo ?? "",
    final_result: entry.finalResult ?? "",
    added_at: isoDate(entry.addedAt),
  };
}

function csvCell(value: string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Same columns as Export call list CSV — only the supplied entries. */
export function callListItemsToCsv(items: CallListCsvInput[]): string {
  const headers = [...CALL_LIST_HEADERS];
  const lines = [headers.join(",")];
  for (const item of items) {
    const row = buildCallListCsvRow(item);
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  return lines.join("\n");
}

export function callListSelectedExportFilename(): string {
  return `vexec-call-list-selected-${businessListDate()}.csv`;
}
