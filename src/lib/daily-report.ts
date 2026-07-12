import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, contacts, dailyRuns, jobListings } from "@/lib/db/schema";
import {
  contactPhonesForDisplay,
  phoneKindLabel,
  sortPhonesForDisplay,
  sourceLabel,
  type SourcedPhone,
} from "@/lib/contact-phones";
import { isPersonalEmail } from "@/lib/phone-utils";
import { businessListDate } from "@/lib/timezone";
import { getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";
import { parseJobLocation } from "@/lib/location-match";
import { contactIsCallable } from "@/lib/lead-score";
import { compareContactsForOutreach } from "@/lib/contact-title-priority";
import { getFilteredBacklogEmailLeads, getTopRankedJobPosts } from "@/lib/backlog-email";
import type { Contact } from "@/lib/db/schema";

export type DailyReportPhone = SourcedPhone & {
  source_label: string;
  kind_label: string;
};

export type CallSheetLead = {
  rank: number;
  score: number;
  company: string;
  company_id: string;
  contact_name: string;
  title: string | null;
  reason_to_call: string | null;
  work_email: string | null;
  personal_email: string | null;
  phones: DailyReportPhone[];
  imessage_capable: boolean | null;
  call_opener: string | null;
  job_title: string | null;
  job_location: string | null;
};

export type DailyCallSheet = {
  run_date: string;
  listings_scraped: number;
  icp_match_count: number;
  companies_enriched: number;
  credits_used: number;
  leads: CallSheetLead[];
  /** Top ranked job posts — always included, enriched or not. */
  top_job_posts: import("@/lib/backlog-email").BacklogEmailLead[];
  backlog_leads: import("@/lib/backlog-email").BacklogEmailLead[];
};

function resolveEmails(contact: {
  email: string | null;
  workEmail: string | null;
  personalEmail: string | null;
}): { workEmail: string | null; personalEmail: string | null } {
  const personalEmail =
    contact.personalEmail ??
    (contact.email && isPersonalEmail(contact.email) ? contact.email : null);
  const workEmail =
    contact.workEmail ??
    (contact.email && !isPersonalEmail(contact.email) ? contact.email : null);

  return {
    workEmail: workEmail && workEmail !== personalEmail ? workEmail : workEmail,
    personalEmail,
  };
}

function pickBestContact(contacts: Contact[]): Contact | undefined {
  return [...contacts].sort((a, b) => {
    const titleCmp = compareContactsForOutreach(a, b);
    if (titleCmp !== 0) return titleCmp;
    const aCallable = contactIsCallable(a);
    const bCallable = contactIsCallable(b);
    if (aCallable !== bCallable) return aCallable ? -1 : 1;
    return a.name.localeCompare(b.name);
  })[0];
}

export async function getDailyCallSheet(): Promise<DailyCallSheet> {
  const runDate = businessListDate();
  const geoSettings = await getGeoFocusSettings();

  const [run] = await db
    .select()
    .from(dailyRuns)
    .where(eq(dailyRuns.runDate, runDate))
    .orderBy(desc(dailyRuns.createdAt))
    .limit(1);

  const companyRows = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.status, "new"),
        eq(companies.enrichRunDate, runDate),
      ),
    )
    .orderBy(desc(companies.leadScore));

  const leads: CallSheetLead[] = [];
  let rank = 0;

  for (const company of companyRows) {
    const companyContacts = await db
      .select()
      .from(contacts)
      .where(eq(contacts.companyId, company.id));

    const callable = companyContacts.filter(contactIsCallable);
    if (!callable.length) continue;

    const listings = await db
      .select()
      .from(jobListings)
      .where(eq(jobListings.companyId, company.id))
      .orderBy(desc(jobListings.sightingsCount));

    const inFocus = listings.filter((l) =>
      jobLocationInFocus(l.location, geoSettings),
    );
    if (!inFocus.length) continue;

    const best = pickBestContact(callable);
    if (!best) continue;

    const { workEmail, personalEmail } = resolveEmails(best);
    const phones = sortPhonesForDisplay(
      contactPhonesForDisplay({
        phones: best.phones,
        phone: best.phone,
        personalPhone: best.personalPhone,
        companyPhone: best.companyPhone,
        sourceProvider: best.sourceProvider,
      }),
    ).map((p) => ({
      ...p,
      source_label: sourceLabel(p.source),
      kind_label: phoneKindLabel(p.kind),
    }));

    rank += 1;
    const primaryJob = inFocus[0];
    leads.push({
      rank,
      score: company.leadScore ?? 0,
      company: company.name,
      company_id: company.id,
      contact_name: best.name,
      title: best.title,
      reason_to_call: company.reasonToCall,
      call_opener: company.callOpener,
      work_email: workEmail,
      personal_email: personalEmail,
      phones,
      imessage_capable: best.imessageCapable,
      job_title: primaryJob?.title ?? null,
      job_location:
        (primaryJob?.location &&
          parseJobLocation(primaryJob.location)?.label) ||
        primaryJob?.location ||
        null,
    });
  }

  return {
    run_date: runDate,
    listings_scraped: run?.listingsScraped ?? 0,
    icp_match_count: run?.icpMatchCount ?? 0,
    companies_enriched: run?.companiesEnriched ?? leads.length,
    credits_used: run?.creditsUsed ?? 0,
    leads,
    top_job_posts: await getTopRankedJobPosts(5),
    backlog_leads:
      leads.length > 0
        ? await getFilteredBacklogEmailLeads()
        : await getFilteredBacklogEmailLeads({
            includeBacklogSection: true,
            backlogLeadLimit: 10,
          }),
  };
}

/** @deprecated Use getDailyCallSheet */
export async function getDailyReportData() {
  const sheet = await getDailyCallSheet();
  return {
    run_date: sheet.run_date,
    listings_scraped: sheet.listings_scraped,
    companies_enriched: sheet.companies_enriched,
    rows: sheet.leads.map((lead) => ({
      company: lead.company,
      contact_name: lead.contact_name,
      title: lead.title,
      work_email: lead.work_email,
      personal_email: lead.personal_email,
      phones: lead.phones,
      imessage_capable: lead.imessage_capable,
      job_title: lead.job_title,
      job_location: lead.job_location,
    })),
  };
}
